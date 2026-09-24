import { dbTest as test } from "../test/integration/dbTest.js";
import assert from "node:assert/strict";

import {
  __resetFailpointsForTests,
  __setFailpointsForTests,
  AGENT_MIGRATION_RESUMABLE_CAPABILITIES,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  BasicTracer,
  DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY,
  EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA,
  EXTERNAL_AGENT_ACTIVITY_PROVENANCE,
  assertSurfaceProducerFactLineage,
  eventsForSpan,
  formatTraceparent,
  InMemoryFailpointRegistry,
  MemoryTraceSink,
  WIKI_AGENT_WORKSPACE_ENABLED,
  WIKI_AGENT_WORKSPACE_ENV,
  parseTraceparent, traceEventRowsForSpan,
  traceSpanFactRowForSpan,
  type AgentMessage,
  type MachineToServerMessage,
  type ServerToMachineMessage,
  type AgentActivity,
  type AgentActivityDetailKind,
  type AgentActivityKind,
  type AgentRuntimeErrorState,
  type ActiveSpan,
  type TrajectoryEntry,
  type Tracer,
  type MachineId,
  type SkillInfo,
  type RuntimeAccountUsageProvider
} from "@botiverse/raft-shared";
import { WIKI_AGENT_WORKSPACE_PACK } from "../generated/wikiAgentWorkspacePack.js";
import {
  REPLICA_ID,
  fingerprintAgentRuntimeError,
  shouldCleanupStaleMachineOwner,
  type MachineCommandRouteResult,
  type RoutedInboxDeliveryOptions,
  type RoutedInboxDeliveryReceiptResult,
} from "../replicaRouter.js";
import { runWithTraceSpan } from "../tracing/semanticTrace.js";
import {
  AgentOrchestrator,
  KimiReasoningEffortUpgradeRequiredError,
  mapExternalPluginActivityEvent,
  partitionTargetScopedMessagesUpToSeq,
  planRuntimeProfileHeartbeatNudgeAction,
  projectMachineCommandRouteTraceAttrs,
  isUsableMachineMigrationTransport,
  type AgentLifecycleEvent,
  type ReadyReconcilePlanAction,
} from "./agentOrchestrator.js";
import { AGENT_ACTIVITY_WRITER_REGISTRY, classifyDaemonActivityObservation } from "./agentLifecycleReducer.js";
import { buildMachineReadModel } from "./machineReadModel.js";
import type { AgentRuntimeErrorMirror, MachineMeta, ReplicaStateStore } from "./replicaStateStore.js";
import type {
  ClaimedComputerLifecycleDispatch,
  ObserveComputerLifecycleResult,
} from "./computerLifecycleOperationService.js";
import type {
  ComputerBroadcastPolicyDecision,
  ComputerSourceFact,
  EvaluateComputerBroadcastPolicyInput,
} from "./computerBroadcastPolicyService.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { machines, users } from "../db/schema.js";
import { createServer } from "./serverService.js";
import { getMachine, recordMachineComputerVersion, registerMachine } from "./machineService.js";
import { BuiltInModelCatalogError } from "./builtinModelCatalogCompatibility.js";


const AGENT_ACTIVITY_KERNEL_ENV_KEYS = [
  "RAFT_ENABLE_AGENT_ACTIVITY_KERNEL_ARBITRATION",
  "SLOCK_ENABLE_AGENT_ACTIVITY_KERNEL_ARBITRATION",
  "RAFT_DISABLE_AGENT_ACTIVITY_KERNEL_ARBITRATION",
  "SLOCK_DISABLE_AGENT_ACTIVITY_KERNEL_ARBITRATION",
] as const;

function withAgentActivityKernelEnv<T>(
  values: Partial<Record<(typeof AGENT_ACTIVITY_KERNEL_ENV_KEYS)[number], string>>,
  fn: () => T,
): T {
  const previous = new Map<string, string | undefined>();
  for (const key of AGENT_ACTIVITY_KERNEL_ENV_KEYS) {
    previous.set(key, process.env[key]);
    const next = values[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }
  try {
    return fn();
  } finally {
    for (const key of AGENT_ACTIVITY_KERNEL_ENV_KEYS) {
      const prior = previous.get(key);
      if (prior === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prior;
      }
    }
  }
}

type PersistedActivityHint = {
  activity: AgentActivityKind;
  detail: string;
  detailKind: AgentActivityDetailKind;
  observedAtMs?: number;
  updatedAt: number;
};

class InMemoryReplicaStateStore implements ReplicaStateStore {
  readonly machineReplicas = new Set<string>();
  readonly machineReplicaOwners = new Map<string, string>();
  readonly machineReplicaGenerations = new Map<string, string>();
  readonly machineStatusVersions = new Map<string, number>();
  readonly agentActivities = new Map<string, PersistedActivityHint>();
  readonly agentRuntimeErrors = new Map<string, AgentRuntimeErrorMirror>();
  readonly wakeLocks = new Set<string>();

  isAvailable(): boolean {
    return true;
  }

  private replicaGeneration = 0;

  async registerMachineReplica(machineId: string): Promise<string> {
    this.replicaGeneration += 1;
    const generation = `generation-${this.replicaGeneration}`;
    this.machineReplicas.add(machineId);
    this.machineReplicaOwners.set(machineId, REPLICA_ID);
    this.machineReplicaGenerations.set(machineId, generation);
    return generation;
  }

  async restoreMachineReplicaGeneration(machineId: string, generation: string): Promise<void> {
    this.machineReplicas.add(machineId);
    this.machineReplicaOwners.set(machineId, REPLICA_ID);
    this.machineReplicaGenerations.set(machineId, generation);
  }

  async unregisterMachineReplica(machineId: string, expectedGeneration?: string): Promise<void> {
    if (expectedGeneration && this.machineReplicaGenerations.get(machineId) !== expectedGeneration) return;
    this.machineReplicas.delete(machineId);
    this.machineReplicaOwners.delete(machineId);
    this.machineReplicaGenerations.delete(machineId);
  }

  async refreshMachineReplica(machineId: string): Promise<void> {
    this.machineReplicas.add(machineId);
  }

  async hasMachineReplica(machineId: string): Promise<boolean> {
    return this.machineReplicas.has(machineId);
  }

  async getMachineReplicaOwner(machineId: string): Promise<string | null> {
    return this.machineReplicaOwners.get(machineId) ?? (this.machineReplicas.has(machineId) ? "remote-replica" : null);
  }

  async bumpMachineStatusVersion(machineId: string): Promise<number> {
    const next = (this.machineStatusVersions.get(machineId) ?? 0) + 1;
    this.machineStatusVersions.set(machineId, next);
    return next;
  }

  async getMachineStatusVersion(machineId: string): Promise<number> {
    return this.machineStatusVersions.get(machineId) ?? 0;
  }

  async acquireWakeLock(agentId: string): Promise<boolean> {
    if (this.wakeLocks.has(agentId)) return false;
    this.wakeLocks.add(agentId);
    return true;
  }

  async releaseWakeLock(agentId: string): Promise<void> {
    this.wakeLocks.delete(agentId);
  }

  async setAgentActivity(
    agentId: string,
    activity: AgentActivityKind,
    detail: string,
    detailKind: AgentActivityDetailKind,
    observedAtMs?: number,
  ): Promise<void> {
    this.agentActivities.set(agentId, {
      activity,
      detail,
      detailKind,
      ...(observedAtMs !== undefined ? { observedAtMs } : {}),
      updatedAt: Date.now(),
    });
  }

  async getAgentActivity(agentId: string): Promise<PersistedActivityHint | null> {
    return this.agentActivities.get(agentId) ?? null;
  }

  async setAgentRuntimeError(agentId: string, error: AgentRuntimeErrorState | null): Promise<void> {
    this.agentRuntimeErrors.set(agentId, {
      error,
      fingerprint: fingerprintAgentRuntimeError(error),
      updatedAt: Date.now(),
    });
  }

  async getAgentRuntimeError(agentId: string): Promise<AgentRuntimeErrorMirror | null> {
    return this.agentRuntimeErrors.get(agentId) ?? null;
  }

  // The fake here keeps a per-machine TTL deadline (clock-driven) so the
  // bidirectional fuse test below can exercise expiry without sleep/timers.
  // `setMachineMeta` resets the deadline to `nowMs() + ttlSec` (mirroring
  // the real `replicaRouter.setMachineMeta` HSET + EXPIRE pipeline);
  // `getMachineMeta` returns null after the deadline (Redis EXPIRE
  // semantics).
  readonly machineMeta = new Map<string, MachineMeta>();
  private readonly machineMetaDeadlines = new Map<string, number>();
  private metaTtlSec = 3600; // mirror replicaRouter MACHINE_META_TTL_SEC default
  private metaNowMs: () => number = () => Date.now();
  // Tests can override the clock + ttl to drive expiry deterministically.
  setMachineMetaClock(nowMs: () => number, ttlSec: number = this.metaTtlSec): void {
    this.metaNowMs = nowMs;
    this.metaTtlSec = ttlSec;
  }
  private bumpMetaDeadline(machineId: string): void {
    this.machineMetaDeadlines.set(machineId, this.metaNowMs() + this.metaTtlSec * 1000);
  }
  private isMetaExpired(machineId: string): boolean {
    const deadline = this.machineMetaDeadlines.get(machineId);
    if (deadline === undefined) return false;
    return this.metaNowMs() >= deadline;
  }

  async setMachineMeta(machineId: string, meta: MachineMeta): Promise<void> {
    this.machineMeta.set(machineId, { ...this.machineMeta.get(machineId), ...meta });
    this.bumpMetaDeadline(machineId);
  }

  async getMachineMeta(machineId: string): Promise<MachineMeta | null> {
    if (this.isMetaExpired(machineId)) {
      this.machineMeta.delete(machineId);
      this.machineMetaDeadlines.delete(machineId);
      return null;
    }
    return this.machineMeta.get(machineId) ?? null;
  }

  async clearMachineMeta(machineId: string): Promise<void> {
    this.machineMeta.delete(machineId);
    this.machineMetaDeadlines.delete(machineId);
  }
}

class RedisUnavailableReplicaStateStore extends InMemoryReplicaStateStore {
  override isAvailable(): boolean {
    return false;
  }
}

class RejectingUnregisterReplicaStateStore extends InMemoryReplicaStateStore {
  override async unregisterMachineReplica(_machineId: string): Promise<void> {
    throw new Error("redis unavailable");
  }

  override async clearMachineMeta(_machineId: string): Promise<void> {
    throw new Error("redis unavailable");
  }
}

class RejectingRegisterReplicaStateStore extends InMemoryReplicaStateStore {
  override async registerMachineReplica(_machineId: string): Promise<string> {
    throw new Error("redis unavailable");
  }
}

class MissingReceiptReplicaStateStore extends InMemoryReplicaStateStore {
  override async registerMachineReplica(machineId: string): Promise<string> {
    await super.registerMachineReplica(machineId);
    return undefined as never;
  }
}

class SupersededRejectingRegisterReplicaStateStore extends InMemoryReplicaStateStore {
  readonly firstRegisterEntered = deferred<void>();
  readonly releaseFirstRegister = deferred<void>();
  private registerCalls = 0;

  override async registerMachineReplica(machineId: string): Promise<string> {
    this.registerCalls += 1;
    if (this.registerCalls === 1) {
      this.firstRegisterEntered.resolve();
      await this.releaseFirstRegister.promise;
      throw new Error("stale registration failed");
    }
    return super.registerMachineReplica(machineId);
  }
}

class SupersededSuccessfulRegisterReplicaStateStore extends InMemoryReplicaStateStore {
  readonly firstRegisterEntered = deferred<void>();
  readonly releaseFirstRegister = deferred<void>();
  registerCalls = 0;

  override async registerMachineReplica(machineId: string): Promise<string> {
    this.registerCalls += 1;
    const generation = `generation-${this.registerCalls}`;
    if (this.registerCalls === 1) {
      this.firstRegisterEntered.resolve();
      await this.releaseFirstRegister.promise;
    }
    await super.registerMachineReplica(machineId);
    return generation;
  }
}

class DisconnectDuringRecommitReplicaStateStore extends InMemoryReplicaStateStore {
  readonly firstRegisterEntered = deferred<void>();
  readonly releaseFirstRegister = deferred<void>();
  readonly thirdRegisterEntered = deferred<void>();
  readonly releaseThirdRegister = deferred<void>();
  readonly unregisterGenerations: Array<string | undefined> = [];
  registerCalls = 0;

  override async registerMachineReplica(machineId: string): Promise<string> {
    this.registerCalls += 1;
    const generation = `generation-${this.registerCalls}`;
    if (this.registerCalls === 1) {
      this.firstRegisterEntered.resolve();
      await this.releaseFirstRegister.promise;
    } else if (this.registerCalls === 3) {
      this.thirdRegisterEntered.resolve();
      await this.releaseThirdRegister.promise;
    }
    this.machineReplicas.add(machineId);
    this.machineReplicaOwners.set(machineId, REPLICA_ID);
    this.machineReplicaGenerations.set(machineId, generation);
    return generation;
  }

  override async unregisterMachineReplica(machineId: string, expectedGeneration?: string): Promise<void> {
    this.unregisterGenerations.push(expectedGeneration);
    await super.unregisterMachineReplica(machineId, expectedGeneration);
  }
}

class HangingUnregisterReplicaStateStore extends InMemoryReplicaStateStore {
  override async unregisterMachineReplica(_machineId: string): Promise<void> {
    return new Promise(() => {});
  }

  override async clearMachineMeta(_machineId: string): Promise<void> {
    return new Promise(() => {});
  }
}

class BuggyReplicaFallbackStore extends InMemoryReplicaStateStore {
  override async hasMachineReplica(_machineId: string): Promise<boolean> {
    return false;
  }

  override async getMachineReplicaOwner(_machineId: string): Promise<string | null> {
    return null;
  }
}

class ExpireOnlyRefreshStore extends InMemoryReplicaStateStore {
  override async refreshMachineReplica(machineId: string): Promise<void> {
    if (!this.machineReplicas.has(machineId)) return;
    this.machineReplicas.add(machineId);
  }
}

class BuggyWakeLockStore extends InMemoryReplicaStateStore {
  override async acquireWakeLock(_agentId: string): Promise<boolean> {
    return true;
  }
}

class CountingReplicaOwnerStore extends InMemoryReplicaStateStore {
  ownerLookupCount = 0;

  override async getMachineReplicaOwner(machineId: string): Promise<string | null> {
    this.ownerLookupCount += 1;
    return super.getMachineReplicaOwner(machineId);
  }
}

type MachineReplicaMutationType = "register" | "unregister" | "refresh";
type MachineReplicaMutation = {
  type: MachineReplicaMutationType;
  machineId: string;
  replicaId: string;
};

class ControlledReplicaState {
  readonly machineOwners = new Map<string, string>();
  readonly machineGenerations = new Map<string, string>();
  readonly machineStatusVersions = new Map<string, number>();
  readonly machineMeta = new Map<string, MachineMeta>();
  readonly agentActivities = new Map<string, PersistedActivityHint>();
  readonly agentRuntimeErrors = new Map<string, AgentRuntimeErrorMirror>();
  readonly wakeLocks = new Set<string>();
  private readonly deferredMutations: Array<{ expected: MachineReplicaMutation; gate: Deferred<void> }> = [];

  deferNextMachineMutation(expected: MachineReplicaMutation): Deferred<void> {
    const gate = deferred<void>();
    this.deferredMutations.push({ expected, gate });
    return gate;
  }

  async runMachineMutation(mutation: MachineReplicaMutation, apply: () => void): Promise<void> {
    const index = this.deferredMutations.findIndex(({ expected }) =>
      expected.type === mutation.type
      && expected.machineId === mutation.machineId
      && expected.replicaId === mutation.replicaId,
    );
    if (index >= 0) {
      const [{ gate }] = this.deferredMutations.splice(index, 1);
      await gate.promise;
    }
    apply();
  }
}

class ControlledReplicaStateStore implements ReplicaStateStore {
  private generation = 0;
  constructor(
    private readonly shared: ControlledReplicaState,
    private readonly replicaId: string,
  ) {}

  isAvailable(): boolean {
    return true;
  }

  async registerMachineReplica(machineId: string): Promise<string> {
    this.generation += 1;
    const generation = `${this.replicaId}-generation-${this.generation}`;
    await this.shared.runMachineMutation(
      { type: "register", machineId, replicaId: this.replicaId },
      () => {
        this.shared.machineOwners.set(machineId, this.replicaId);
        this.shared.machineGenerations.set(machineId, generation);
      },
    );
    return generation;
  }

  async restoreMachineReplicaGeneration(machineId: string, generation: string): Promise<void> {
    await this.shared.runMachineMutation(
      { type: "register", machineId, replicaId: this.replicaId },
      () => {
        this.shared.machineOwners.set(machineId, this.replicaId);
        this.shared.machineGenerations.set(machineId, generation);
      },
    );
  }

  async unregisterMachineReplica(machineId: string, expectedGeneration?: string): Promise<void> {
    await this.shared.runMachineMutation(
      { type: "unregister", machineId, replicaId: this.replicaId },
      () => {
        if (
          this.shared.machineOwners.get(machineId) === this.replicaId
          && (!expectedGeneration || this.shared.machineGenerations.get(machineId) === expectedGeneration)
        ) {
          this.shared.machineOwners.delete(machineId);
          this.shared.machineGenerations.delete(machineId);
        }
      },
    );
  }

  async refreshMachineReplica(machineId: string): Promise<void> {
    await this.shared.runMachineMutation(
      { type: "refresh", machineId, replicaId: this.replicaId },
      () => {
        this.shared.machineOwners.set(machineId, this.replicaId);
      },
    );
  }

  async hasMachineReplica(machineId: string): Promise<boolean> {
    return this.shared.machineOwners.has(machineId);
  }

  async getMachineReplicaOwner(machineId: string): Promise<string | null> {
    return this.shared.machineOwners.get(machineId) ?? null;
  }

  async bumpMachineStatusVersion(machineId: string): Promise<number> {
    const next = (this.shared.machineStatusVersions.get(machineId) ?? 0) + 1;
    this.shared.machineStatusVersions.set(machineId, next);
    return next;
  }

  async getMachineStatusVersion(machineId: string): Promise<number> {
    return this.shared.machineStatusVersions.get(machineId) ?? 0;
  }

  async acquireWakeLock(agentId: string): Promise<boolean> {
    if (this.shared.wakeLocks.has(agentId)) return false;
    this.shared.wakeLocks.add(agentId);
    return true;
  }

  async releaseWakeLock(agentId: string): Promise<void> {
    this.shared.wakeLocks.delete(agentId);
  }

  async setAgentActivity(
    agentId: string,
    activity: AgentActivityKind,
    detail: string,
    detailKind: AgentActivityDetailKind,
    observedAtMs?: number,
  ): Promise<void> {
    this.shared.agentActivities.set(agentId, {
      activity,
      detail,
      detailKind,
      ...(observedAtMs !== undefined ? { observedAtMs } : {}),
      updatedAt: Date.now(),
    });
  }

  async getAgentActivity(agentId: string): Promise<PersistedActivityHint | null> {
    return this.shared.agentActivities.get(agentId) ?? null;
  }

  async setAgentRuntimeError(agentId: string, error: AgentRuntimeErrorState | null): Promise<void> {
    this.shared.agentRuntimeErrors.set(agentId, {
      error,
      fingerprint: fingerprintAgentRuntimeError(error),
      updatedAt: Date.now(),
    });
  }

  async getAgentRuntimeError(agentId: string): Promise<AgentRuntimeErrorMirror | null> {
    return this.shared.agentRuntimeErrors.get(agentId) ?? null;
  }

  async setMachineMeta(machineId: string, meta: MachineMeta): Promise<void> {
    this.shared.machineMeta.set(machineId, { ...this.shared.machineMeta.get(machineId), ...meta });
  }

  async getMachineMeta(machineId: string): Promise<MachineMeta | null> {
    return this.shared.machineMeta.get(machineId) ?? null;
  }

  async clearMachineMeta(machineId: string): Promise<void> {
    this.shared.machineMeta.delete(machineId);
  }

}

type IntervalHandle = { id: number };
type TestClock = {
  now(): number;
  scheduleRepeated(fn: () => void, ms: number): unknown;
  cancelRepeated(timer: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
};

class FakeClock {
  private nowMs = 0;
  private nextId = 1;
  private intervals = new Map<number, { ms: number; nextAt: number; fn: () => void }>();
  private timeouts = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.nowMs;
  }

  scheduleRepeated(fn: () => void, ms: number): IntervalHandle {
    const handle = { id: this.nextId++ };
    this.intervals.set(handle.id, { ms, nextAt: this.nowMs + ms, fn });
    return handle;
  }

  cancelRepeated(handle: unknown): void {
    if (!handle || typeof handle !== "object" || !("id" in handle)) return;
    this.intervals.delete((handle as IntervalHandle).id);
  }

  setTimeout(fn: () => void, ms: number): IntervalHandle {
    const handle = { id: this.nextId++ };
    this.timeouts.set(handle.id, { at: this.nowMs + ms, fn });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (!handle || typeof handle !== "object" || !("id" in handle)) return;
    this.timeouts.delete((handle as IntervalHandle).id);
  }

  advance(ms: number): void {
    const target = this.nowMs + ms;

    while (true) {
      let next: { type: "interval"; id: number; ms: number; at: number; fn: () => void }
        | { type: "timeout"; id: number; at: number; fn: () => void }
        | null = null;
      for (const [id, interval] of this.intervals) {
        if (interval.nextAt > target) continue;
        if (!next || interval.nextAt < next.at) {
          next = { type: "interval", id, ms: interval.ms, at: interval.nextAt, fn: interval.fn };
        }
      }
      for (const [id, timeout] of this.timeouts) {
        if (timeout.at > target) continue;
        if (!next || timeout.at < next.at) {
          next = { type: "timeout", id, at: timeout.at, fn: timeout.fn };
        }
      }

      if (!next) break;

      this.nowMs = next.at;
      if (next.type === "timeout") {
        this.timeouts.delete(next.id);
      }
      next.fn();

      const current = next.type === "interval" ? this.intervals.get(next.id) : null;
      if (current && next.type === "interval") {
        current.nextAt = this.nowMs + current.ms;
      }
    }

    this.nowMs = target;
  }
}

class IncrementingNowClock extends FakeClock {
  private nextNowMs = 0;

  override now(): number {
    // Expose accidental multiple clock reads for one accepted ingress frame.
    return this.nextNowMs++;
  }
}

class DeterministicAgentOrchestrator extends AgentOrchestrator {
  constructor(
    store: ReplicaStateStore = new InMemoryReplicaStateStore(),
    clock?: TestClock,
    tracer?: Tracer,
  ) {
    super(store, clock, tracer);
  }

  protected override async persistAgentStatus(_agentId: string, _status: "active" | "inactive" | "stopped", _sessionId?: string) {
    // No-op in deterministic tests; status semantics are asserted via cache state.
  }

  protected override async persistAgentStatusFromSignal(_agentId: string, _status: "active" | "inactive" | "stopped", _sessionId?: string) {
    // No-op in deterministic tests; status semantics are asserted via cache state.
    return true;
  }

  protected override async persistAgentLastRuntimeError(_agentId: string, _lastRuntimeError: AgentRuntimeErrorState) {
    // No-op in deterministic tests; runtime error state is asserted via cache state.
    return true;
  }

  protected override async clearPersistedAgentLastRuntimeError(_agentId: string) {
    // No-op in deterministic tests; runtime error state is asserted via cache state.
    return true;
  }

  protected override async loadAgentForSessionBroadcast(agentId: string): Promise<any> {
    const cached = (this as any).agentStateCache.get(agentId);
    if (!cached) return null;
    return {
      id: agentId,
      status: cached.status,
      sessionId: cached.sessionId,
    };
  }

  protected override async autoAssignConnectedMachine(_serverId: string, _machineId: string) {
    // No-op in deterministic tests; connect-path contracts should not require DB writes.
  }

  protected override async isLegacyMachinePrincipalMigrated(_machineId: string): Promise<boolean> {
    return false;
  }

  protected override async loadAgentsForDisconnect(_machineId: string): Promise<any[]> {
    return [];
  }

  protected override async updateMachineHeartbeat(_machineId: string) {
    // No-op in deterministic tests; the scenarios care only about replica-state transitions.
  }

  protected override async persistMachineComputerVersion(
    _machineId: string,
    _computerVersion: string | null | undefined,
    _reportedAt: Date,
  ): Promise<boolean> {
    // No-op in deterministic tests; focused subclasses capture this seam.
    return false;
  }

  protected override async loadRuntimeContextMachine(_machineId: string) {
    // No-op in deterministic tests; start-path contracts should not require DB reads.
    return null;
  }

  protected override async loadLatestPersistedActivityHint(_agentId: string): Promise<PersistedActivityHint | null> {
    return null;
  }

  protected override async loadJointActivityProjectionChannelIdsForAgent(_agentId: string, _sourceServerId: string): Promise<string[]> {
    return [];
  }

  protected override async persistActivityEvent(
    _agentId: string,
    _activity: string,
    _detail: string,
    _entries: TrajectoryEntry[],
    _createdAt: Date,
    _dedupeKey?: string,
  ): Promise<boolean> {
    // No-op in deterministic tests. The activity-event log is a DB side-effect
    // (appendAgentActivityEvent → getDb). With no DB it throws-and-is-caught,
    // flooding every broadcastActivity path with "Failed to persist activity
    // event" noise; worse, in a shared unit-server shard a sibling file's DB
    // lifecycle made this env-sensitive (a #161 test passed isolated/full-file
    // but went red only under sharding). Skipping it keeps the harness's
    // no-persistence design intact — activity is asserted via cache/replica
    // state, not the durable log. (#161 fix-forward)
    return false;
  }

  protected override async hasPassiveDeliveryScope(_agentId: string): Promise<boolean> {
    // Deterministic tests don't seed `agent_scopes` and don't connect to a DB.
    // The scope gate is exercised in dedicated integration tests; here we
    // assume the agent has the default-on `inbox:receive` grant.
    return true;
  }

  protected override async canAgentAccessDeliveryTarget(_agentId: string, _agent: any, _message: AgentMessage): Promise<boolean> {
    // Deterministic tests don't seed channel membership in a DB. Visibility
    // failures are exercised by explicit subclasses below.
    return true;
  }

  protected override async loadAgentForDelivery(agentId: string): Promise<any> {
    const cached = (this as any).agentStateCache.get(agentId);
    if (!cached) return null;
    return {
      id: agentId,
      serverId: cached.serverId,
      machineId: cached.machineId,
      sessionId: cached.sessionId,
      status: cached.status,
      name: cached.name,
      displayName: cached.displayName,
      avatarUrl: null,
      description: cached.description,
      model: cached.model,
      runtime: cached.runtime,
      lastRuntimeError: cached.lastRuntimeError ?? null,
      reasoningEffort: cached.reasoningEffort,
      envVars: cached.envVars,
      executionMode: "cloud",
      deletedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }
}

class ComputerVersionCaptureOrchestrator extends DeterministicAgentOrchestrator {
  readonly computerVersionReports: Array<{
    machineId: string;
    computerVersion: string | null | undefined;
    reportedAt: Date;
  }> = [];

  protected override async loadAgentsForReadyReconcile() {
    return [];
  }

  protected override async observeComputerLifecycleAck() {
    return { status: "pending", operationId: "operation-1" } as const;
  }

  protected override async persistMachineComputerVersion(
    machineId: string,
    computerVersion: string | null | undefined,
    reportedAt: Date,
  ): Promise<boolean> {
    this.computerVersionReports.push({ machineId, computerVersion, reportedAt });
    return true;
  }
}

class HangingLifecycleObservationOrchestrator extends DeterministicAgentOrchestrator {
  protected override observeComputerLifecycleDisconnect(): Promise<never> {
    return new Promise(() => {});
  }
}

class RejectingLifecycleObservationOrchestrator extends DeterministicAgentOrchestrator {
  constructor(
    private readonly observationError: unknown,
    clock?: TestClock,
    tracer?: Tracer,
  ) {
    super(undefined, clock, tracer);
  }

  protected override observeComputerLifecycleDisconnect(): Promise<never> {
    return Promise.reject(this.observationError);
  }
}

class DeferredLegacyFenceOrchestrator extends DeterministicAgentOrchestrator {
  readonly secondValidationEntered = deferred<void>();
  readonly secondValidationGate = deferred<boolean>();
  validationCalls = 0;

  protected override async isLegacyMachinePrincipalMigrated(_machineId: string): Promise<boolean> {
    this.validationCalls += 1;
    if (this.validationCalls === 1) return false;
    this.secondValidationEntered.resolve();
    return this.secondValidationGate.promise;
  }
}

class StartRoutingMismatchDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  protected override async loadAgentForStart(agentId: string) {
    return {
      id: agentId,
      serverId: "server-1",
      machineId: "machine-1",
      sessionId: null,
      status: "inactive",
      name: "agent-1",
      displayName: null,
      avatarUrl: null,
      description: null,
      model: "gpt-5",
      runtime: "codex",
      lastRuntimeError: null,
      reasoningEffort: null,
      envVars: null,
      executionMode: "cloud",
      deletedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as Awaited<ReturnType<DeterministicAgentOrchestrator["loadAgentForStart"]>>;
  }
  protected override async routeMachineCommandCrossReplica(): Promise<boolean> {
    return false;
  }
}

class BuggySelfOwnedReplicaReachabilityOrchestrator extends StartRoutingMismatchDeterministicOrchestrator {
  override async getMachineStatus(machineId: string): Promise<"online" | "offline"> {
    if ((this as any).hasMachineLocally(machineId)) return "online";
    return (await (this as any).replicaStateStore.hasMachineReplica(machineId)) ? "online" : "offline";
  }
}

class HeartbeatDeterministicAgentOrchestrator extends DeterministicAgentOrchestrator {
  override async handleMachineDisconnect(machineId: string, ws?: unknown, _context: unknown = {}) {
    const connections = (this as unknown as { machineConnections: Map<string, { ws: unknown }> }).machineConnections;
    const conn = connections.get(machineId);
    if (ws && conn && conn.ws !== ws) return;
    if (!conn) return;

    await this.unregisterMachine(machineId);

    const cache = (this as unknown as { agentStateCache: Map<string, { machineId: string | null; status: string }> }).agentStateCache;
    const activity = (this as unknown as { agentActivity: Map<string, { activity: string; detail: string; updatedAt: number }> }).agentActivity;
    const inboxes = (this as unknown as { agentInboxes: Map<string, { inbox: AgentMessage[]; pendingReceive: { resolve: (msgs: AgentMessage[]) => void; timer: ReturnType<typeof setTimeout>; finish: (msgs: AgentMessage[]) => void } | null }> }).agentInboxes;

    for (const [agentId, agent] of cache.entries()) {
      if (agent.machineId !== machineId) continue;
      if (agent.status === "active") {
        activity.set(agentId, { activity: "offline", detail: "", updatedAt: Date.now() });
      }
      const inbox = inboxes.get(agentId);
      if (inbox?.pendingReceive) {
        clearTimeout(inbox.pendingReceive.timer);
        inbox.pendingReceive.resolve([]);
      }
      inboxes.delete(agentId);
    }
  }
}

type DeliverabilityNetwork = {
  owners: Map<string, string>;
  replicas: Map<string, MessageDeliverabilityOrchestrator>;
};

type StartRoutingNetwork = {
  shared: ControlledReplicaState;
  replicas: Map<string, StartRoutingDeterministicOrchestrator>;
};

class StartRoutingDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  constructor(
    readonly replicaId: string,
    readonly network: StartRoutingNetwork,
    store: ReplicaStateStore,
    clock?: TestClock,
  ) {
    super(store, clock);
    this.network.replicas.set(replicaId, this);
  }

  protected override async loadAgentForStart(agentId: string) {
    return {
      id: agentId,
      serverId: "server-1",
      machineId: "machine-1",
      sessionId: null,
      status: "active",
      name: "agent-1",
      displayName: null,
      avatarUrl: null,
      description: null,
      model: "gpt-5",
      runtime: "codex",
      lastRuntimeError: null,
      reasoningEffort: null,
      envVars: null,
      executionMode: "cloud",
      deletedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as Awaited<ReturnType<DeterministicAgentOrchestrator["loadAgentForStart"]>>;
  }
  protected override async routeMachineCommandCrossReplica(
    machineId: string,
    msg: ServerToMachineMessage,
    localMachineIds: Set<string>,
  ): Promise<boolean> {
    if (localMachineIds.has(machineId)) return false;
    const targetReplica = this.network.shared.machineOwners.get(machineId);
    if (!targetReplica || targetReplica === this.replicaId) return false;

    const target = this.network.replicas.get(targetReplica);
    assert.ok(target, `missing target replica ${targetReplica}`);
    return target.handleRoutedMachineCommand(machineId, msg);
  }
}

class MessageDeliverabilityOrchestrator extends DeterministicAgentOrchestrator {
  readonly deliveredToMachine: Array<{ machineId: string; msg: ServerToMachineMessage }> = [];

  constructor(
    readonly replicaId: string,
    readonly network: DeliverabilityNetwork,
  ) {
    super(new InMemoryReplicaStateStore());
    this.network.replicas.set(replicaId, this);
  }

  protected override async routeMachineCommandCrossReplica(
    machineId: string,
    msg: ServerToMachineMessage,
    localMachineIds: Set<string>,
  ): Promise<boolean> {
    if (localMachineIds.has(machineId)) return false;
    const targetReplica = this.network.owners.get(machineId);
    if (!targetReplica || targetReplica === this.replicaId) return false;

    const target = this.network.replicas.get(targetReplica);
    assert.ok(target, `missing target replica ${targetReplica}`);
    target.deliveredToMachine.push({ machineId, msg });
    return target.sendToLocalMachine(machineId, msg);
  }

  protected override async routeInboxDeliveryCrossReplica(
    agentId: string,
    machineId: string,
    message: AgentMessage,
    localMachineIds: Set<string>,
  ): Promise<boolean> {
    if (localMachineIds.has(machineId)) return false;
    const targetReplica = this.network.owners.get(machineId);
    if (!targetReplica || targetReplica === this.replicaId) return false;

    const target = this.network.replicas.get(targetReplica);
    assert.ok(target, `missing target replica ${targetReplica}`);
    target.deliverToLocalInbox(agentId, message);
    return true;
  }
}

class EndpointRoutedMessageDeliverabilityOrchestrator extends MessageDeliverabilityOrchestrator {
  protected override async routeMachineCommandCrossReplica(
    machineId: string,
    msg: ServerToMachineMessage,
    localMachineIds: Set<string>,
  ): Promise<boolean> {
    if (localMachineIds.has(machineId)) return false;
    const targetReplica = this.network.owners.get(machineId);
    if (!targetReplica || targetReplica === this.replicaId) return false;

    const target = this.network.replicas.get(targetReplica);
    assert.ok(target, `missing target replica ${targetReplica}`);
    return target.handleRoutedMachineCommand(machineId, msg);
  }

  protected override async routeInboxDeliveryCrossReplica(
    agentId: string,
    machineId: string,
    message: AgentMessage,
    localMachineIds: Set<string>,
  ): Promise<boolean> {
    if (localMachineIds.has(machineId)) return false;
    const targetReplica = this.network.owners.get(machineId);
    if (!targetReplica || targetReplica === this.replicaId) return false;

    const target = this.network.replicas.get(targetReplica);
    assert.ok(target, `missing target replica ${targetReplica}`);
    return target.handleRoutedInboxDelivery(agentId, machineId, message);
  }

  protected override async routeInboxDeliveryWithReceiptCrossReplica(
    agentId: string,
    machineId: string,
    message: AgentMessage,
    localMachineIds: Set<string>,
    deliveryOptions: RoutedInboxDeliveryOptions,
  ): Promise<RoutedInboxDeliveryReceiptResult> {
    if (localMachineIds.has(machineId)) return { routed: false };
    const targetReplica = this.network.owners.get(machineId);
    if (!targetReplica || targetReplica === this.replicaId) return { routed: false };

    const target = this.network.replicas.get(targetReplica);
    assert.ok(target, `missing target replica ${targetReplica}`);
    return {
      routed: true,
      receipt: await target.handleRoutedInboxDeliveryWithReceipt(
        agentId,
        machineId,
        message,
        deliveryOptions,
      ),
    };
  }

  protected override async loadAgentForStart(agentId: string) {
    const cached = (this as any).agentStateCache.get(agentId);
    assert.ok(cached, `missing cached agent ${agentId}`);

    return {
      id: agentId,
      serverId: cached.serverId,
      machineId: cached.machineId,
      sessionId: cached.sessionId,
      status: cached.status,
      name: cached.name,
      displayName: cached.displayName,
      avatarUrl: null,
      description: cached.description,
      model: cached.model,
      runtime: cached.runtime,
      reasoningEffort: cached.reasoningEffort,
      envVars: cached.envVars,
      executionMode: "cloud",
      deletedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as Awaited<ReturnType<DeterministicAgentOrchestrator["loadAgentForStart"]>>;
  }}

class PublishOnlyInboxRouteOrchestrator extends DeterministicAgentOrchestrator {
  publishCalls = 0;

  protected override async routeInboxDeliveryCrossReplica(
    _agentId: string,
    _machineId: string,
    _message: AgentMessage,
    _localMachineIds: Set<string>,
  ): Promise<boolean> {
    this.publishCalls += 1;
    return true;
  }
}

class MalformedQueuedReceiptOrchestrator extends DeterministicAgentOrchestrator {
  protected override async routeInboxDeliveryWithReceiptCrossReplica(): Promise<RoutedInboxDeliveryReceiptResult> {
    return {
      routed: true,
      receipt: { status: "queued", reason: "unknown_queue_claim" },
    };
  }
}

class AccessRevokedEndpointRoutedOrchestrator extends EndpointRoutedMessageDeliverabilityOrchestrator {
  protected override async canAgentAccessDeliveryTarget(): Promise<boolean> {
    return false;
  }
}

class ScopeRevokedEndpointRoutedOrchestrator extends EndpointRoutedMessageDeliverabilityOrchestrator {
  readonly passiveScopeChecks: string[] = [];

  protected override async hasPassiveDeliveryScope(agentId: string): Promise<boolean> {
    this.passiveScopeChecks.push(agentId);
    return false;
  }
}

class BuggyStaleLocalMessageRoutingOrchestrator extends MessageDeliverabilityOrchestrator {
  protected override getRoutableLocalMachineIds(): Set<string> {
    return new Set((this as unknown as { machineConnections: Map<string, unknown> }).machineConnections.keys());
  }
}

class BuggyRoutedMachineCommandOrchestrator extends MessageDeliverabilityOrchestrator {
  override async handleRoutedMachineCommand(machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    return this.sendToLocalMachine(machineId, msg);
  }
}

class BuggyRoutedInboxDeliveryOrchestrator extends MessageDeliverabilityOrchestrator {
  override async handleRoutedInboxDelivery(agentId: string, _machineId: string | null, message: AgentMessage): Promise<boolean> {
    this.deliverToLocalInbox(agentId, message);
    return true;
  }
}

class BuggyPayloadAnchoredRoutedInboxOrchestrator extends MessageDeliverabilityOrchestrator {
  override async handleRoutedInboxDelivery(agentId: string, machineId: string | null, message: AgentMessage): Promise<boolean> {
    if (!machineId) {
      this.deliverToLocalInbox(agentId, message);
      return true;
    }

    const localMachineIds = this.getRoutableLocalMachineIds();
    if (localMachineIds.has(machineId)) {
      this.deliverToLocalInbox(agentId, message);
      return true;
    }

    const rerouted = await this.routeInboxDeliveryCrossReplica(agentId, machineId, message, localMachineIds);
    if (rerouted) {
      return true;
    }

    this.deliverToLocalInbox(agentId, message);
    return true;
  }
}

class BuggyHeartbeatTimeoutOrchestrator extends HeartbeatDeterministicAgentOrchestrator {
  protected override onMachineHeartbeatTick(machineId: string, conn: any) {
    void this.handleMachineDisconnect(machineId, undefined, { cause: "heartbeat_timeout" });
    try { conn?.ws?.terminate?.(); } catch { /* ignore */ }
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolveFn) => {
    resolve = resolveFn;
  });
  return { promise, resolve };
}

async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function waitForCondition(predicate: () => boolean, attempts = 20): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function advanceClockAndWaitForCondition(clock: FakeClock, ms: number, predicate: () => boolean): Promise<void> {
  clock.advance(ms);
  await waitForCondition(predicate);
}

class WakeLockDeterministicAgentOrchestrator extends DeterministicAgentOrchestrator {
  readonly startMessages: Array<Extract<ServerToMachineMessage, { type: "agent:start" }>> = [];

  constructor(
    store: ReplicaStateStore,
    private readonly options: { holdSend?: Promise<void>; onSend?: () => void; sendSucceeds?: boolean } = {},
  ) {
    super(store);
  }

  protected override async loadAgentForStart(agentId: string) {
    return {
      id: agentId,
      serverId: "server-1",
      machineId: "machine-1",
      sessionId: null,
      status: "active",
      name: "agent-1",
      displayName: null,
      avatarUrl: null,
      description: null,
      model: "gpt-5",
      runtime: "codex",
      reasoningEffort: null,
      envVars: null,
      executionMode: "cloud",
      deletedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as Awaited<ReturnType<DeterministicAgentOrchestrator["loadAgentForStart"]>>;
  }
  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "agent:start") {
      this.startMessages.push(msg);
      this.options.onSend?.();
      if (this.options.holdSend) {
        await this.options.holdSend;
      }
    }
    return this.options.sendSucceeds ?? true;
  }

  override async handleMachineMessage(machineId: string, msg: MachineToServerMessage) {
    if (msg.type === "agent:session") {
      (this as any).updateCache(msg.agentId, { runtimeState: "running_idle", status: "active", sessionId: msg.sessionId });
      (this as any).maybeResolveStartingActivity(msg.agentId);
      await (this as any).replicaStateStore.releaseWakeLock(msg.agentId);
      return;
    }
    if (msg.type === "agent:status") {
      const normalizedStatus = msg.status === "sleeping" ? "active" : msg.status;
      (this as any).updateCache(msg.agentId, {
        runtimeState: normalizedStatus === "active" ? "running_idle" : "not_running",
        status: normalizedStatus,
      });
      if (normalizedStatus === "active") {
        (this as any).maybeResolveStartingActivity(msg.agentId);
      }
      if (normalizedStatus === "inactive") {
        await (this as any).replicaStateStore.releaseWakeLock(msg.agentId);
      }
      return;
    }
    return super.handleMachineMessage(machineId, msg);
  }
}

class LegacyKimiCapabilityStartOrchestrator extends WakeLockDeterministicAgentOrchestrator {
  constructor(private readonly persistedSessionId: string | null) {
    super(new InMemoryReplicaStateStore());
  }

  protected override async loadAgentForStart(agentId: string) {
    const agent = await super.loadAgentForStart(agentId);
    return {
      ...agent,
      sessionId: this.persistedSessionId,
      runtime: "kimi-sdk",
      model: "kimi-code/k3",
      runtimeConfig: {
        version: 1,
        runtime: "kimi-sdk",
        model: { kind: "preset", id: "kimi-code/k3" },
        mode: { kind: "default" },
        reasoningEffort: "balanced-plus",
        envVars: null,
      },
    } as Awaited<ReturnType<WakeLockDeterministicAgentOrchestrator["loadAgentForStart"]>>;
  }

  override async detectMachineRuntimeModels() {
    return {
      kind: "live" as const,
      value: {
        default: "kimi-code/k3",
        models: [{ id: "kimi-code/k3", label: "Kimi K3" }],
      },
    };
  }
}

class RejectingBuiltInCatalogStartOrchestrator extends WakeLockDeterministicAgentOrchestrator {
  protected override async loadAgentForStart(agentId: string) {
    const agent = await super.loadAgentForStart(agentId);
    return {
      ...agent,
      model: "openrouter/unsupported-model",
      runtime: "builtin",
      runtimeConfig: {
        version: 1,
        runtime: "builtin",
        provider: {
          kind: "preset",
          providerId: "openrouter",
          apiKey: "secret",
        },
        model: { kind: "preset", id: "openrouter/unsupported-model" },
        mode: { kind: "default" },
        hostUserState: "forbidden",
      },
    } as Awaited<
      ReturnType<WakeLockDeterministicAgentOrchestrator["loadAgentForStart"]>
    >;
  }

  override async validateBuiltInPresetForMachine(): Promise<never> {
    throw new BuiltInModelCatalogError(
      "builtin_model_unsupported_by_target",
      "unsupported",
      {
        requestedModel: "openrouter/unsupported-model",
        daemonVersion: "1.0.17",
        computerVersion: "1.0.17",
        catalogRuntimeVersion: "0.83.0",
        recovery: "upgrade_or_reselect",
      },
    );
  }
}

test("Built-in catalog preflight rejects before wake lock, cache, activity, or spawn side effects", async () => {
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new RejectingBuiltInCatalogStartOrchestrator(store);

  await assert.rejects(
    () => orchestrator.startAgent("agent-1"),
    (error: unknown) =>
      error instanceof BuiltInModelCatalogError &&
      error.code === "builtin_model_unsupported_by_target",
  );

  assert.deepEqual([...store.wakeLocks], []);
  assert.deepEqual([...store.agentActivities], []);
  assert.equal(
    (
      orchestrator as unknown as { agentStateCache: Map<string, unknown> }
    ).agentStateCache.has("agent-1"),
    false,
  );
  assert.deepEqual(orchestrator.startMessages, []);
  orchestrator.shutdown();
});

class WikiPackStartDeterministicAgentOrchestrator extends WakeLockDeterministicAgentOrchestrator {
  readonly wikiStartMessages: Array<Extract<ServerToMachineMessage, { type: "agent:start:wiki" }>> = [];

  protected override async loadAgentForStart(agentId: string) {
    const agent = await super.loadAgentForStart(agentId);
    return {
      ...agent,
      envVars: {
        [WIKI_AGENT_WORKSPACE_ENV]: WIKI_AGENT_WORKSPACE_ENABLED,
      },
    } as Awaited<ReturnType<WakeLockDeterministicAgentOrchestrator["loadAgentForStart"]>>;
  }

  protected override async sendToMachine(machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "agent:start:wiki") {
      this.wikiStartMessages.push(msg);
      return true;
    }
    return super.sendToMachine(machineId, msg);
  }
}

class LaunchGuardDeterministicAgentOrchestrator extends DeterministicAgentOrchestrator {
  readonly startMessages: Array<Extract<ServerToMachineMessage, { type: "agent:start" }>> = [];

  constructor(store: ReplicaStateStore = new InMemoryReplicaStateStore()) {
    super(store);
  }

  protected override async loadAgentForStart(agentId: string) {
    return {
      id: agentId,
      serverId: "server-1",
      machineId: "machine-1",
      sessionId: null,
      status: "active",
      name: "agent-1",
      displayName: null,
      avatarUrl: null,
      description: null,
      model: "gpt-5",
      runtime: "codex",
      reasoningEffort: null,
      envVars: null,
      executionMode: "cloud",
      deletedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as Awaited<ReturnType<DeterministicAgentOrchestrator["loadAgentForStart"]>>;
  }
  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "agent:start") {
      this.startMessages.push(msg);
    }
    return true;
  }

  override async handleMachineMessage(machineId: string, msg: MachineToServerMessage) {
    if (msg.type === "agent:status" || msg.type === "agent:activity" || msg.type === "agent:session") {
      if (msg.type === "agent:status" || msg.type === "agent:session") {
        return super.handleMachineMessage(machineId, msg);
      }

      const agent = await (this as any).validateMachineAgentMessage(machineId, "server-1", msg.agentId, msg.type);
      if (!agent) return;
      if (!(this as any).shouldAcceptLifecycleEvent(machineId, agent, msg.type, (msg as any).launchId)) {
        return;
      }

      if (msg.type === "agent:activity") {
        (this as any).broadcastActivity(msg.agentId, msg.activity, msg.detail, msg.entries);
        return;
      }
    }

    return super.handleMachineMessage(machineId, msg);
  }
}

class ResumeCatchupTraceDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  readonly startMessages: Array<Extract<ServerToMachineMessage, { type: "agent:start" }>> = [];

  protected override async loadAgentForStart(agentId: string) {
    return {
      id: agentId,
      serverId: "server-1",
      machineId: "machine-1",
      sessionId: "session-1",
      status: "active",
      name: "agent-1",
      displayName: null,
      avatarUrl: null,
      description: null,
      model: "gpt-5",
      runtime: "codex",
      lastRuntimeError: null,
      reasoningEffort: null,
      envVars: null,
      executionMode: "cloud",
      deletedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as Awaited<ReturnType<DeterministicAgentOrchestrator["loadAgentForStart"]>>;
  }

  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "agent:start") {
      this.startMessages.push(msg);
    }
    return true;
  }
}

class FailingLaunchGuardDeterministicAgentOrchestrator extends LaunchGuardDeterministicAgentOrchestrator {
  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "agent:start") {
      this.startMessages.push(msg);
    }
    return false;
  }
}

/**
 * Simulates the pre-fix behavior where handleMachineDisconnect did not check ws identity.
 * Without the stale guard, any disconnect call (including from an old/replaced socket) would
 * unconditionally tear down the machine's replica state and mark agents offline.
 */
class BuggyStaleDisconnectOrchestrator extends DeterministicAgentOrchestrator {
  override async handleMachineDisconnect(machineId: string, _ws?: unknown, _context?: unknown) {
    const connections = (this as unknown as { machineConnections: Map<string, unknown> }).machineConnections;
    if (!connections.has(machineId)) return;
    connections.delete(machineId);
    // Directly invoke the store to simulate unregisterMachine's side-effect
    await (this as unknown as { replicaStateStore: { unregisterMachineReplica(id: string): Promise<void> } })
      .replicaStateStore.unregisterMachineReplica(machineId);
  }
}

class BuggyConcurrentReceiveOrchestrator extends DeterministicAgentOrchestrator {
  override receiveMessages(agentId: string, block: boolean, timeoutMs: number, signal?: AbortSignal): Promise<AgentMessage[]> {
    let inbox = (this as any).agentInboxes.get(agentId);
    if (!inbox) {
      inbox = { inbox: [], pendingReceive: null };
      (this as any).agentInboxes.set(agentId, inbox);
    }

    if (inbox.inbox.length > 0) {
      const msgs = [...inbox.inbox];
      inbox.inbox = [];
      return Promise.resolve(msgs);
    }

    if (!block) return Promise.resolve([]);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const ib = (this as any).agentInboxes.get(agentId);
        if (ib?.pendingReceive) {
          ib.pendingReceive = null;
          resolve([]);
        }
      }, timeoutMs);

      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          const ib = (this as any).agentInboxes.get(agentId);
          if (ib?.pendingReceive) {
            ib.pendingReceive = null;
          }
          resolve([]);
        }, { once: true });
      }

      inbox.pendingReceive = {
        resolve,
        timer,
        finish: resolve,
      };
    });
  }
}

class DeferredLocalFallbackDeliverMessageOrchestrator extends DeterministicAgentOrchestrator {
  readonly routeGate = deferred<boolean>();
  routeEntered = false;

  protected override async routeInboxDeliveryCrossReplica(
    _agentId: string,
    _machineId: string,
    _message: AgentMessage,
    _localMachineIds: Set<string>,
  ): Promise<boolean> {
    this.routeEntered = true;
    return this.routeGate.promise;
  }
}

class InactiveWindowDeliverMessageOrchestrator extends DeterministicAgentOrchestrator {
  readonly sentToMachine: ServerToMachineMessage[] = [];

  protected override async loadAgentForStart(agentId: string) {
    const cached = (this as any).agentStateCache.get(agentId);
    assert.ok(cached, `missing cached agent ${agentId}`);
    return {
      id: agentId,
      serverId: cached.serverId,
      machineId: cached.machineId,
      sessionId: cached.sessionId,
      status: cached.status,
      name: cached.name,
      displayName: cached.displayName,
      avatarUrl: null,
      description: cached.description,
      model: cached.model,
      runtime: cached.runtime,
      reasoningEffort: cached.reasoningEffort,
      envVars: cached.envVars,
      executionMode: "cloud",
      deletedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as Awaited<ReturnType<DeterministicAgentOrchestrator["loadAgentForStart"]>>;
  }
  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    this.sentToMachine.push(msg);
    return true;
  }

  override sendToLocalMachine(_machineId: string, msg: ServerToMachineMessage): boolean {
    this.sentToMachine.push(msg);
    return true;
  }
}

class StaleCachedStoppedDeliveryOrchestrator extends InactiveWindowDeliverMessageOrchestrator {
  constructor(private readonly persistedStatus: "active" | "inactive" | "stopped") {
    super();
  }

  protected override async loadAgentForDelivery(agentId: string): Promise<any> {
    const agent = await super.loadAgentForDelivery(agentId);
    return agent ? { ...agent, status: this.persistedStatus } : null;
  }
}

class FailingWakeDeliverMessageOrchestrator extends InactiveWindowDeliverMessageOrchestrator {
  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    this.sentToMachine.push(msg);
    return msg.type !== "agent:start";
  }
}

class ResetFailureDeterministicOrchestrator extends InactiveWindowDeliverMessageOrchestrator {
  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    this.sentToMachine.push(msg);
    return msg.type !== "agent:start";
  }
}

/** Persisting the runtimes fails — the disk is full, the DB is down, pick your disaster. */
class CapabilitiesPersistFailsOrchestrator extends InactiveWindowDeliverMessageOrchestrator {
  protected override async persistMachineCapabilities(): Promise<void> {
    throw new Error("capabilities persist failed");
  }

  protected override async loadAgentsForReadyReconcile() {
    return [];
  }
}

class ReadyReconcileDeterministicOrchestrator extends InactiveWindowDeliverMessageOrchestrator {
  protected override async persistMachineCapabilities(
    _machineId: string,
    _runtimes: string[],
    _hostname?: string,
    _os?: string,
    _daemonVersion?: string | null,
  ) {
    // No-op for determ tests.
  }

  protected override async loadAgentsForReadyReconcile(machineId: string) {
    const agents = [...(this as any).agentStateCache.entries()]
      .filter(([, agent]) => agent.machineId === machineId)
      .map(([id, agent]) => ({
        id,
        serverId: agent.serverId,
        machineId: agent.machineId,
        sessionId: agent.sessionId,
        status: agent.status,
        name: agent.name,
        displayName: agent.displayName,
        avatarUrl: null,
        description: agent.description,
        model: agent.model,
        runtime: agent.runtime,
        lastRuntimeError: agent.lastRuntimeError ?? null,
        reasoningEffort: agent.reasoningEffort,
        envVars: agent.envVars,
        executionMode: "cloud",
        deletedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }));
    return agents as Awaited<ReturnType<DeterministicAgentOrchestrator["loadAgentForStart"]>>[];
  }

  async callApplyReadyReconcileAction(machineId: string, agentId: string, action: ReadyReconcilePlanAction, span?: ActiveSpan) {
    const agent = (await this.loadAgentsForReadyReconcile(machineId)).find((candidate) => candidate.id === agentId);
    assert.ok(agent, `missing ready-reconcile agent ${agentId}`);
    await this.applyReadyReconcileAction(machineId, agent, action, span);
  }
}

class RestartFailureTerminalizationOrchestrator extends ReadyReconcileDeterministicOrchestrator {
  readonly terminalizations: Array<{
    operationId: string;
    terminal: string;
    reason: string;
  }> = [];
  readonly lifecycleReceipts: Array<Extract<ServerToMachineMessage, { type: "computer:lifecycle:receipt" }>> = [];

  constructor(
    private readonly terminalizationStatuses: Array<ObserveComputerLifecycleResult["status"]>,
  ) {
    super();
  }

  protected override async terminalizeComputerLifecycleOperation(input: {
    operationId: string;
    serverId: string;
    machineId: string;
    terminal: "failed" | "rolled_back" | "superseded";
    reason: string;
    loadedComputerVersion?: string;
  }) {
    this.terminalizations.push({
      operationId: input.operationId,
      terminal: input.terminal,
      reason: input.reason,
    });
    const status = this.terminalizationStatuses.shift() ?? "rejected";
    if (status === "terminal") {
      return {
        status,
        fact: {
          operationId: input.operationId,
          serverId: input.serverId,
          machineId: input.machineId,
          action: input.operationId.startsWith("upgrade-") ? "upgrade" : "restart",
          actorUserId: null,
          terminal: input.terminal,
          terminalReason: input.reason,
        },
        projections: [],
      } satisfies ObserveComputerLifecycleResult;
    }
    if (status === "late_after_terminal") {
      return {
        status,
        operationId: input.operationId,
        terminal: input.terminal,
      } satisfies ObserveComputerLifecycleResult;
    }
    if (status === "pending") {
      return { status, operationId: input.operationId } satisfies ObserveComputerLifecycleResult;
    }
    return { status: "rejected" as const };
  }

  protected override async sendToMachine(
    _machineId: string,
    msg: ServerToMachineMessage,
  ): Promise<boolean> {
    if (msg.type === "computer:lifecycle:receipt") this.lifecycleReceipts.push(msg);
    return true;
  }
}

class ReadyReconcileSocketDeliveryOrchestrator extends DeterministicAgentOrchestrator {
  protected override async persistMachineCapabilities(
    _machineId: string,
    _runtimes: string[],
    _hostname?: string,
    _os?: string,
    _daemonVersion?: string | null,
  ) {
    // No-op for deterministic tests.
  }

  protected override async loadAgentsForReadyReconcile(machineId: string) {
    const agents = [...(this as any).agentStateCache.entries()]
      .filter(([, agent]) => agent.machineId === machineId)
      .map(([id, agent]) => ({
        id,
        serverId: agent.serverId,
        machineId: agent.machineId,
        sessionId: agent.sessionId,
        status: agent.status,
        name: agent.name,
        displayName: agent.displayName,
        avatarUrl: null,
        description: agent.description,
        model: agent.model,
        runtime: agent.runtime,
        lastRuntimeError: agent.lastRuntimeError ?? null,
        reasoningEffort: agent.reasoningEffort,
        envVars: agent.envVars,
        executionMode: "cloud",
        deletedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }));
    return agents as Awaited<ReturnType<DeterministicAgentOrchestrator["loadAgentForStart"]>>[];
  }
}

class ColdCacheReadyReconcileDeterministicOrchestrator extends InactiveWindowDeliverMessageOrchestrator {
  readonly persistedAgents = new Map<string, any>();

  addPersistedActiveAgent(agentId: string, machineId: string) {
    this.persistedAgents.set(agentId, {
      id: agentId,
      serverId: "server-1",
      machineId,
      sessionId: null,
      status: "active",
      name: agentId,
      displayName: null,
      avatarUrl: null,
      description: null,
      model: "gpt-5",
      runtime: "codex",
      lastRuntimeError: null,
      reasoningEffort: null,
      envVars: null,
      executionMode: "cloud",
      deletedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
  }

  protected override async persistMachineCapabilities(
    _machineId: string,
    _runtimes: string[],
    _hostname?: string,
    _os?: string,
    _daemonVersion?: string | null,
  ) {
    // No-op for deterministic tests.
  }

  protected override async loadAgentsForReadyReconcile(machineId: string) {
    return [...this.persistedAgents.values()].filter((agent) => agent.machineId === machineId);
  }

  protected override async loadAgentForDelivery(agentId: string): Promise<any> {
    return this.persistedAgents.get(agentId) ?? null;
  }

  protected override async loadAgentForStart(agentId: string): Promise<any> {
    return this.persistedAgents.get(agentId) ?? null;
  }
}

class StopApplyDeterministicOrchestrator extends InactiveWindowDeliverMessageOrchestrator {
  async callApplyStopAction(agentId: string, reason: "manual" | "internal") {
    const agent = await (this as any).getCachedAgent(agentId);
    assert.ok(agent, `missing stop-apply agent ${agentId}`);
    const nextStatus = reason === "manual" ? "stopped" : "inactive";
    await this.applyStopAction({
      agentId,
      serverId: agent.serverId,
      machineId: agent.machineId,
      reason,
      previousStatus: agent.status,
      nextStatus,
    });
  }
}

class UnreachableStopApplyDeterministicOrchestrator extends StopApplyDeterministicOrchestrator {
  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    this.sentToMachine.push(msg);
    return false;
  }
}

class VolatileDeliveryDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  readonly legacyReadAdvances: Array<{ agentId: string; channelId: string; seq: number }> = [];
}

class PurgeInboxDeterministicOrchestrator extends VolatileDeliveryDeterministicOrchestrator {
  readonly sentToMachine: Array<{ machineId: string; msg: ServerToMachineMessage }> = [];
  readonly threadChannelIdsByParent = new Map<string, string[]>();

  protected override async sendToMachine(machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    this.sentToMachine.push({ machineId, msg });
    return true;
  }

  protected override async listThreadChannelIdsForInboxPurge(parentChannelId: string): Promise<string[]> {
    return this.threadChannelIdsByParent.get(parentChannelId) ?? [];
  }
}

class RoutedOwnershipApplyDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  readonly calls: string[] = [];

  async callApplyRoutedOwnershipAction(
    action: "handle-locally" | "reroute-then-fallback" | "fallback",
    rerouteResult = false,
  ) {
    return this.applyRoutedOwnershipAction({
      action,
      handleLocally: async () => {
        this.calls.push("local");
        return true;
      },
      rerouteToCurrentOwner: async () => {
        this.calls.push("reroute");
        return rerouteResult;
      },
      fallback: async () => {
        this.calls.push("fallback");
        return false;
      },
    });
  }
}

class LocalDeliveryGateApplyDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  callApplyLocalDeliveryGateAction(
    action: "deliver-locally" | "drop-delivery",
    agentId: string,
    message: AgentMessage,
  ) {
    return this.applyLocalDeliveryGateAction({
      action,
      agentId,
      message,
    });
  }
}

class SendToMachineApplyDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  readonly calls: string[] = [];

  async callApplySendToMachineAction(
    action: "send-locally" | "reroute-then-warn" | "warn-offline",
    rerouteResult: boolean | MachineCommandRouteResult = false,
  ) {
    let observedRouteResult: MachineCommandRouteResult | null = null;
    const delivered = await this.applySendToMachineAction({
      action,
      machineId: "machine-1",
      msg: { type: "ping" },
      sendLocally: () => {
        this.calls.push("local");
        return true;
      },
      reroute: async () => {
        this.calls.push("reroute");
        return rerouteResult;
      },
      onRouteResult: (result) => {
        observedRouteResult = result;
      },
    });
    return { delivered, observedRouteResult };
  }

}

class InvalidStatusReadyReconcileDeterministicOrchestrator extends ReadyReconcileDeterministicOrchestrator {
  constructor(private readonly invalidStatus: string) {
    super();
  }

  protected override async loadAgentsForReadyReconcile(machineId: string) {
    const agents = await super.loadAgentsForReadyReconcile(machineId);
    return agents.map((agent) => ({ ...agent, status: this.invalidStatus as any }));
  }
}

class InvalidStatusStartDeterministicOrchestrator extends WakeLockDeterministicAgentOrchestrator {
  constructor(
    private readonly invalidStatus: string,
    store: ReplicaStateStore = new InMemoryReplicaStateStore(),
    options: { holdSend?: Promise<void>; onSend?: () => void; sendSucceeds?: boolean } = {},
  ) {
    super(store, options);
  }

  protected override async loadAgentForStart(agentId: string) {
    const agent = await super.loadAgentForStart(agentId);
    return { ...agent, status: this.invalidStatus as any };
  }
}

class DeferredResetWindowOrchestrator extends InactiveWindowDeliverMessageOrchestrator {
  readonly inactivePersistGate = deferred<void>();
  inactivePersistEntered = false;

  protected override async resetPersistedAgentSession(_agentId: string) {
    // No-op for determ tests.
  }

  protected override async persistAgentStatus(_agentId: string, status: "active" | "inactive" | "stopped", _sessionId?: string) {
    if (status === "inactive" && !this.inactivePersistEntered) {
      this.inactivePersistEntered = true;
      await this.inactivePersistGate.promise;
    }
  }
}

class SendPrimitiveHarness extends DeterministicAgentOrchestrator {
  callBestEffortSend() {
    (this as any).sendBestEffortToMachine("machine-1", { type: "ping" }, "best-effort send failed");
  }

  callRequiredSend(offlineMessage = "required send failed") {
    return (this as any).sendRequiredToMachine("machine-1", { type: "ping" }, offlineMessage);
  }
}

class RouteTraceSendPrimitiveHarness extends DeterministicAgentOrchestrator {
  constructor(
    private readonly routeResult: MachineCommandRouteResult,
    store: ReplicaStateStore = new InMemoryReplicaStateStore(),
    tracer?: Tracer,
  ) {
    super(store, undefined, tracer);
  }

  callRequiredSend(offlineMessage = "required send failed") {
    return (this as any).sendRequiredToMachine("machine-1", { type: "ping" }, offlineMessage);
  }

  protected override async routeMachineCommandCrossReplica(): Promise<MachineCommandRouteResult> {
    return this.routeResult;
  }
}

class PersistedActivityLogDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  readonly emittedActivityPayloads: Array<{
    agentId: string;
    activity: string;
    activityKind?: string;
    detail: string;
    detailKind?: string;
    timestamp: number;
    entries?: TrajectoryEntry[];
    clientSeq?: number;
    probeId?: string;
    isHeartbeat?: boolean;
    isRefreshOnly?: boolean;
    producerFactId?: string;
    serverSeq?: number;
  }> = [];
  private readonly persistedDedupeKeys = new Set<string>();

  constructor(
    private readonly persistedLogs: Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>> = new Map(),
    clock?: TestClock,
    tracer?: Tracer,
  ) {
    super(new InMemoryReplicaStateStore(), clock, tracer);
    (this as unknown as { io: { to(room: string): { emit(event: string, payload: unknown): void } } }).io = {
      to: () => ({
        emit: (event: string, payload: unknown) => {
          if (event === "agent:activity") {
            this.emittedActivityPayloads.push(payload as {
              agentId: string;
              activity: string;
              activityKind?: string;
              detail: string;
              detailKind?: string;
              timestamp: number;
              entries?: TrajectoryEntry[];
              clientSeq?: number;
              probeId?: string;
              isHeartbeat?: boolean;
              isRefreshOnly?: boolean;
              producerFactId?: string;
              serverSeq?: number;
            });
          }
        },
      }),
    };
  }

  protected override async persistActivityEvent(
    agentId: string,
    _activity: string,
    _detail: string,
    entries: TrajectoryEntry[],
    createdAt: Date,
    dedupeKey?: string,
  ): Promise<boolean> {
    if (dedupeKey) {
      const scopedDedupeKey = `${agentId}:${dedupeKey}`;
      if (this.persistedDedupeKeys.has(scopedDedupeKey)) {
        return false;
      }
      this.persistedDedupeKeys.add(scopedDedupeKey);
    }
    const existing = this.persistedLogs.get(agentId) ?? [];
    const timestamp = createdAt.getTime();
    const persisted = [...existing, ...entries.map((entry) => ({ timestamp, entry }))];
    this.persistedLogs.set(agentId, persisted);
    return true;
  }

  protected override async loadPersistedActivityLog(agentId: string, limit: number) {
    const existing = this.persistedLogs.get(agentId) ?? [];
    return existing.slice(-limit);
  }

  protected override async loadLatestPersistedActivityHint(agentId: string): Promise<PersistedActivityHint | null> {
    const existing = this.persistedLogs.get(agentId) ?? [];
    const latest = existing.at(-1);
    if (!latest) return null;
    const activity: AgentActivityKind =
      latest.entry.kind === "status"
        ? latest.entry.activityKind ?? latest.entry.activity
        : "working";
    const detailKind: AgentActivityDetailKind =
      latest.entry.kind === "status"
        ? latest.entry.detailKind ?? "other"
        : latest.entry.kind === "tool_start"
          ? latest.entry.toolName === "bash" ? "running_command" : "other"
          : latest.entry.kind === "compaction_started"
            ? "compacting_context"
            : latest.entry.kind === "compaction_finished"
              ? "compaction_finished"
              : "other";
    return {
      activity,
      detail:
        latest.entry.kind === "status"
          ? latest.entry.detail
          : latest.entry.kind === "thinking"
            ? latest.entry.text
            : latest.entry.kind === "tool_start"
              ? latest.entry.toolInput
              : latest.entry.kind === "text"
                ? latest.entry.text
                : latest.entry.kind === "system" || latest.entry.kind === "slock_action"
                  ? latest.entry.text
                  : latest.entry.kind === "compaction_started"
                    ? "Compacting context"
                    : "Context compaction finished",
      detailKind,
      updatedAt: latest.timestamp,
    };
  }
}

class BaseActivityLogPersistenceHarness extends DeterministicAgentOrchestrator {
  readonly emittedActivityPayloads: unknown[] = [];

  constructor(
    clock?: TestClock,
    tracer?: Tracer,
  ) {
    super(new InMemoryReplicaStateStore(), clock, tracer);
    (this as any).io = {
      to: () => ({
        emit: (event: string, payload: unknown) => {
          if (event === "agent:activity") {
            this.emittedActivityPayloads.push(payload);
          }
        },
      }),
    };
  }

  callPersistActivityEvent(
    agentId: string,
    activity: string,
    detail: string,
    entries: TrajectoryEntry[],
    createdAt = new Date(0),
    dedupeKey?: string,
  ): Promise<boolean> {
    return this.persistActivityEvent(agentId, activity, detail, entries, createdAt, dedupeKey);
  }
}

class ReadyReconcileActivityLogDeterministicOrchestrator extends PersistedActivityLogDeterministicOrchestrator {
  protected override async loadAgentsForDisconnect(machineId: string) {
    return this.loadAgentsForReadyReconcile(machineId);
  }

  protected override async loadAgentsForReadyReconcile(machineId: string) {
    const agents = [...(this as any).agentStateCache.entries()]
      .filter(([, agent]) => agent.machineId === machineId)
      .map(([id, agent]) => ({
        id,
        serverId: agent.serverId,
        machineId: agent.machineId,
        sessionId: agent.sessionId,
        status: agent.status,
        name: agent.name,
        displayName: agent.displayName,
        avatarUrl: null,
        description: agent.description,
        model: agent.model,
        runtime: agent.runtime,
        lastRuntimeError: agent.lastRuntimeError ?? null,
        reasoningEffort: agent.reasoningEffort,
        envVars: agent.envVars,
        executionMode: "cloud",
        deletedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }));
    return agents as Awaited<ReturnType<DeterministicAgentOrchestrator["loadAgentForStart"]>>[];
  }

  async callApplyReadyReconcileAction(machineId: string, agentId: string, action: ReadyReconcilePlanAction, span?: ActiveSpan) {
    const agent = (await this.loadAgentsForReadyReconcile(machineId)).find((candidate) => candidate.id === agentId);
    assert.ok(agent, `missing ready-reconcile agent ${agentId}`);
    await this.applyReadyReconcileAction(machineId, agent, action, span);
  }
}

class ActivityResolutionDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  constructor(
    store: ReplicaStateStore,
    private persistedHint: PersistedActivityHint | null,
    clock: TestClock,
    tracer?: Tracer,
  ) {
    super(store, clock, tracer);
  }

  setPersistedHint(persistedHint: PersistedActivityHint | null) {
    this.persistedHint = persistedHint;
  }

  protected override async loadLatestPersistedActivityHint(_agentId: string): Promise<PersistedActivityHint | null> {
    return this.persistedHint;
  }
}

class ActivityBroadcastApplyDeterministicOrchestrator extends PersistedActivityLogDeterministicOrchestrator {
  callApplyActivityBroadcastAction(
    action: "persist-and-emit-now" | "debounce-only",
    agentId: string,
    activity: AgentActivityKind,
    detail: string,
    now: number,
    persistedEntries: TrajectoryEntry[],
    joinKeys?: { launchId?: string; clientSeq?: number; probeId?: string; producerFactId?: string },
    detailKind: AgentActivityDetailKind = "other",
  ) {
    this.applyActivityBroadcastAction({
      action,
      agentId,
      activity,
      detail,
      detailKind,
      now,
      persistedEntries,
      ...(joinKeys?.launchId !== undefined ? { launchId: joinKeys.launchId } : {}),
      ...(joinKeys?.clientSeq !== undefined ? { clientSeq: joinKeys.clientSeq } : {}),
      ...(joinKeys?.probeId !== undefined ? { probeId: joinKeys.probeId } : {}),
      ...(joinKeys?.producerFactId !== undefined ? { producerFactId: joinKeys.producerFactId } : {}),
    });
  }
}

class ActivityHintApplyDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  callApplyActivityHintResolutionAction(
    action: "return-snapshot" | "return-offline" | "ignore-hint" | "return-read-through-snapshot",
    agentId: string,
    snapshot: { activity: AgentActivityKind; detail: string; detailKind: AgentActivityDetailKind; updatedAt: number },
  ) {
    return this.applyActivityHintResolutionAction({
      action,
      agentId,
      snapshot,
    });
  }
}

class ActivityHintInputDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  callLoadActivityHintResolutionPlanInput(
    agent: { status: "active" | "inactive" | "stopped"; machineId: string | null } | null,
    snapshot: { activity: AgentActivityKind; detail: string; detailKind: AgentActivityDetailKind; updatedAt: number },
    source: "local-cache" | "redis",
  ) {
    return this.loadActivityHintResolutionPlanInput({
      agent: agent as any,
      snapshot,
      source,
    });
  }
}

class MachineReachabilityInputDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  callLoadMachineReachabilityPlanInput(agent: { machineId: string | null } | null) {
    return this.loadMachineReachabilityPlanInput({ agent: agent as any });
  }
}

class StaleActivityApplyDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  callApplyStaleActivitySweepAction(
    action: "keep-current" | "sweep-online",
    agentId: string,
    now: number,
  ) {
    this.applyStaleActivitySweepAction({ action, agentId, now });
  }
}

class StaleTransientApplyDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  callApplyStaleTransientNormalizationAction(
    action: "keep-current" | "normalize-online",
    agentId: string,
    source: "local-cache" | "redis",
    now: number,
  ) {
    return this.applyStaleTransientNormalizationAction({ action, agentId, source, now });
  }
}

class SyntheticRepairFactDeterministicOrchestrator extends PersistedActivityLogDeterministicOrchestrator {
  callApplyStaleActivitySweepAction(action: "keep-current" | "sweep-online", agentId: string, now: number) {
    this.applyStaleActivitySweepAction({ action, agentId, now });
  }

  callApplyStaleTransientNormalizationAction(
    action: "keep-current" | "normalize-online",
    agentId: string,
    source: "local-cache" | "redis",
    now: number,
  ) {
    return this.applyStaleTransientNormalizationAction({ action, agentId, source, now });
  }
}
function seedMachineConnection(
  orchestrator: AgentOrchestrator,
  machineId: string,
  ws: unknown,
  daemonVersion: string | null = "1.0.0",
  capabilities: readonly string[] = [],
) {
  const now = (orchestrator as unknown as { clock?: { now(): number } }).clock?.now() ?? Date.now();
  const conn = {
    ws,
    machineId,
    serverId: "server-1",
    principalKind: "unknown",
    connectionEpochId: `machine:${machineId}:connection:test-epoch`,
    heartbeatTimer: null,
    lastPong: now,
    lastIngressAt: now,
    daemonVersion,
    capabilities: new Set(capabilities),
    migrationTransport: null,
    shutdownIntent: null,
    computerVersion: null,
  };
  (orchestrator as unknown as { machineConnections: Map<string, unknown> }).machineConnections.set(machineId, conn);
  return conn;
}

class SkillsListDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  readonly skillsRequests: Extract<ServerToMachineMessage, { type: "agent:skills:list" }>[] = [];

  constructor(clock?: TestClock, tracer?: Tracer) {
    super(new InMemoryReplicaStateStore(), clock, tracer);
  }

  protected override async getMachineForAgent(_agentId: string): Promise<any> {
    return { machineId: "machine-1", conn: {} };
  }

  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "agent:skills:list") {
      this.skillsRequests.push(msg);
    }
    return true;
  }
}

function testSkill(name: string): SkillInfo {
  return {
    name,
    displayName: name,
    description: `${name} skill`,
    userInvocable: true,
  };
}

test("agent skills list correlates results by request id and ignores mismatches", async () => {
  const orchestrator = new SkillsListDeterministicOrchestrator();
  const pending = orchestrator.getAgentSkills("agent-1", "codex");
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await flushMicrotasks();

  assert.equal(orchestrator.skillsRequests.length, 1);
  const requestId = orchestrator.skillsRequests[0]?.requestId;
  assert.match(requestId ?? "", /^[0-9a-f-]{36}$/);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:skills:list_result",
    agentId: "agent-1",
    requestId: "wrong-request",
    global: [testSkill("wrong")],
    workspace: [],
  });
  await flushMicrotasks();
  assert.equal(settled, false);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:skills:list_result",
    agentId: "agent-1",
    requestId,
    global: [testSkill("matched")],
    workspace: [],
  });

  const result = await pending;
  assert.deepEqual(result.global.map((skill) => skill.name), ["matched"]);
  orchestrator.shutdown();
});

test("agent skills list preserves legacy unscoped daemon result fallback", async () => {
  const orchestrator = new SkillsListDeterministicOrchestrator();
  const pending = orchestrator.getAgentSkills("agent-1", "codex");
  await flushMicrotasks();

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:skills:list_result",
    agentId: "agent-1",
    global: [testSkill("legacy")],
    workspace: [],
  });

  const result = await pending;
  assert.deepEqual(result.global.map((skill) => skill.name), ["legacy"]);
  orchestrator.shutdown();
});

test("agent skills list rejects ambiguous concurrent legacy unscoped results", async () => {
  const clock = new FakeClock();
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new SkillsListDeterministicOrchestrator(clock, tracer);
  const codexPending = orchestrator.getAgentSkills("agent-1", "codex");
  const claudePending = orchestrator.getAgentSkills("agent-1", "claude");
  let settledCount = 0;
  void codexPending.then(() => { settledCount += 1; }, () => { settledCount += 1; });
  void claudePending.then(() => { settledCount += 1; }, () => { settledCount += 1; });
  await flushMicrotasks();

  assert.equal(orchestrator.skillsRequests.length, 2);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:skills:list_result",
    agentId: "agent-1",
    global: [testSkill("legacy")],
    workspace: [],
  });
  await flushMicrotasks();

  assert.equal(settledCount, 0);
  const legacySpan = sink.getTrace(traceId).find((entry) => entry.name === "server.agent.skills.list");
  assert.equal(legacySpan?.attrs?.outcome, "legacy_ambiguous_result");
  assert.equal(legacySpan?.attrs?.matching_pending_count, 2);

  const codexRequestId = orchestrator.skillsRequests.find((msg) => msg.runtime === "codex")?.requestId;
  assert.ok(codexRequestId);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:skills:list_result",
    agentId: "agent-1",
    requestId: codexRequestId,
    global: [testSkill("codex")],
    workspace: [],
  });
  const result = await codexPending;
  assert.deepEqual(result.global.map((skill) => skill.name), ["codex"]);

  clock.advance(15_000);
  await assert.rejects(claudePending, /Skills list request timed out/);
  orchestrator.shutdown();
});

test("agent skills list legacy fallback observes retained timeout without success", async () => {
  const clock = new FakeClock();
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new SkillsListDeterministicOrchestrator(clock, tracer);
  const timedOutPending = orchestrator.getAgentSkills("agent-1", "codex");
  await flushMicrotasks();

  clock.advance(15_000);
  await assert.rejects(timedOutPending, /Skills list request timed out/);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:skills:list_result",
    agentId: "agent-1",
    global: [testSkill("late-legacy")],
    workspace: [],
  });
  await flushMicrotasks();

  const spans = sink.getTrace(traceId)
    .filter((entry) => entry.name === "server.agent.skills.list");
  const facts = spans.map((entry) => traceSpanFactRowForSpan(entry, TRACE_EVENT_ROW_TEST_RESOURCE));
  assert.deepEqual(facts.map((fact) => fact.outcome), [
    "timeout",
    "legacy_late_after_timeout",
  ]);
  assert.equal(spans[1]?.attrs?.matching_pending_count, 0);
  assert.equal(spans[1]?.attrs?.retained_timeout_count, 1);
  clock.advance(60_000);
  await flushMicrotasks();
  orchestrator.shutdown();
});

test("agent skills list legacy fallback resolves retry despite retained timed-out request", async () => {
  const clock = new FakeClock();
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new SkillsListDeterministicOrchestrator(clock, tracer);
  const timedOutPending = orchestrator.getAgentSkills("agent-1", "codex");
  await flushMicrotasks();

  clock.advance(15_000);
  await assert.rejects(timedOutPending, /Skills list request timed out/);

  const retryPending = orchestrator.getAgentSkills("agent-1", "codex");
  let retrySkillNames: string[] | null = null;
  void retryPending.then((result) => { retrySkillNames = result.global.map((skill) => skill.name); });
  await flushMicrotasks();
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:skills:list_result",
    agentId: "agent-1",
    global: [testSkill("retry")],
    workspace: [],
  });
  await flushMicrotasks();

  assert.deepEqual(retrySkillNames, ["retry"]);

  const spans = sink.getTrace(traceId)
    .filter((entry) => entry.name === "server.agent.skills.list");
  const facts = spans.map((entry) => traceSpanFactRowForSpan(entry, TRACE_EVENT_ROW_TEST_RESOURCE));
  assert.deepEqual(facts.map((fact) => fact.outcome), [
    "timeout",
    "legacy_unscoped_result",
  ]);
  assert.equal(spans[1]?.attrs?.matching_pending_count, 1);
  assert.equal(spans[1]?.attrs?.retained_timeout_count, 1);
  orchestrator.shutdown();
});

test("agent skills list traces request id results with wrong agent as non-success", async () => {
  const clock = new FakeClock();
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new SkillsListDeterministicOrchestrator(clock, tracer);
  const pending = orchestrator.getAgentSkills("agent-1", "codex");
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await flushMicrotasks();

  const requestId = orchestrator.skillsRequests[0]?.requestId;
  assert.ok(requestId);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:skills:list_result",
    agentId: "agent-2",
    requestId,
    global: [testSkill("wrong-agent")],
    workspace: [],
  });
  await flushMicrotasks();

  assert.equal(settled, false);
  const outcomes = sink.getTrace(traceId)
    .filter((entry) => entry.name === "server.agent.skills.list")
    .map((entry) => entry.attrs?.outcome);
  assert.deepEqual(outcomes, ["wrong_agent_for_request_id"]);
  assert.equal(outcomes.includes("result_before_timeout"), false);
  clock.advance(15_000);
  await assert.rejects(pending, /Skills list request timed out/);
  orchestrator.shutdown();
});

test("agent skills list traces request id results with wrong machine as non-success", async () => {
  const clock = new FakeClock();
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new SkillsListDeterministicOrchestrator(clock, tracer);
  const pending = orchestrator.getAgentSkills("agent-1", "codex");
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await flushMicrotasks();

  const requestId = orchestrator.skillsRequests[0]?.requestId;
  assert.ok(requestId);
  await orchestrator.handleMachineMessage("machine-2", {
    type: "agent:skills:list_result",
    agentId: "agent-1",
    requestId,
    global: [testSkill("wrong-machine")],
    workspace: [],
  });
  await flushMicrotasks();

  assert.equal(settled, false);
  const outcomes = sink.getTrace(traceId)
    .filter((entry) => entry.name === "server.agent.skills.list")
    .map((entry) => entry.attrs?.outcome);
  assert.deepEqual(outcomes, ["wrong_machine_for_request_id"]);
  assert.equal(outcomes.includes("result_before_timeout"), false);
  clock.advance(15_000);
  await assert.rejects(pending, /Skills list request timed out/);
  orchestrator.shutdown();
});

test("agent skills list timeout keeps late-result observation alive", async () => {
  const clock = new FakeClock();
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new SkillsListDeterministicOrchestrator(clock, tracer);
  const pending = orchestrator.getAgentSkills("agent-1", "codex");
  await flushMicrotasks();

  const requestId = orchestrator.skillsRequests[0]?.requestId;
  assert.ok(requestId);

  clock.advance(15_000);
  await assert.rejects(pending, /Skills list request timed out/);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:skills:list_result",
    agentId: "agent-1",
    requestId,
    global: [testSkill("late")],
    workspace: [],
  });
  await flushMicrotasks();

  const facts = sink.getTrace(traceId)
    .filter((entry) => entry.name === "server.agent.skills.list")
    .map((entry) => traceSpanFactRowForSpan(entry, TRACE_EVENT_ROW_TEST_RESOURCE));
  assert.deepEqual(facts.map((fact) => fact.outcome), ["timeout", "late_after_timeout"]);
  orchestrator.shutdown();
});

test("agent skills list disconnect rejects before daemon timeout", async () => {
  const clock = new FakeClock();
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new SkillsListDeterministicOrchestrator(clock, tracer);
  seedMachineConnection(orchestrator, "machine-1", { readyState: 3, close: () => {} });

  const pending = orchestrator.getAgentSkills("agent-1", "codex");
  await flushMicrotasks();

  await orchestrator.handleMachineDisconnect("machine-1", undefined, { cause: "socket_close" });
  await assert.rejects(pending, /Machine disconnected while listing skills/);

  const span = sink.getTrace(traceId).find((entry) => entry.name === "server.agent.skills.list");
  assert.equal(span?.attrs?.outcome, "disconnected_before_result");
  assert.equal(span?.attrs?.disconnect_cause, "socket_close");
  orchestrator.shutdown();
});

class RuntimeAccountUsageBoundaryDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  readonly attachedByMachine = new Map<string, string>();
  readonly refreshRequests: Array<{ machineId: string; provider: RuntimeAccountUsageProvider }> = [];
  readonly cachedSnapshots: Array<{ machineId: string; snapshot: unknown }> = [];

  protected override async loadRuntimeAccountUsageAttacher(
    _serverId: string,
    machineId: string,
  ): Promise<string | null> {
    return this.attachedByMachine.get(machineId) ?? null;
  }

  protected override async isRuntimeAccountUsageFeatureEnabled(): Promise<boolean> {
    return true;
  }

  protected override async writeRuntimeAccountUsageSnapshot(machineId: string, snapshot: unknown): Promise<void> {
    this.cachedSnapshots.push({ machineId, snapshot });
  }

  override async requestRuntimeAccountUsageRefresh(
    machineId: string,
    provider: RuntimeAccountUsageProvider,
  ): Promise<boolean> {
    this.refreshRequests.push({ machineId, provider });
    return true;
  }

  seedRuntimeUsageConnection(
    machineId: string,
    principalKind: "computer" | "legacy_machine" | "unknown",
  ): void {
    const now = 1_000;
    (this as unknown as { machineConnections: Map<string, unknown> }).machineConnections.set(machineId, {
      ws: makeFakeWs(),
      machineId,
      serverId: "server-1",
      principalKind,
      connectionEpochId: `machine:${machineId}:connection:usage-boundary`,
      heartbeatTimer: null,
      runtimeAccountUsageTimer: null,
      lastPong: now,
      lastIngressAt: now,
      daemonVersion: "1.0.0",
      capabilities: new Set<string>(),
      runtimes: ["codex"],
      migrationTransport: null,
      shutdownIntent: null,
      computerVersion: principalKind === "computer" ? "1.0.0" : null,
    });
  }

  async collectRuntimeAccountUsageForTest(machineId: string): Promise<void> {
    const conn = (this as unknown as { machineConnections: Map<string, unknown> }).machineConnections.get(machineId);
    assert.ok(conn);
    await this.collectScheduledRuntimeAccountUsage(machineId, conn as never);
  }
}

function runtimeAccountUsageBoundarySnapshot() {
  return {
    protocolVersion: 1,
    provider: "codex",
    collectedAt: "2026-08-04T00:00:00.000Z",
    staleAfter: "2026-08-04T00:30:00.000Z",
    acquisition: "structured_event",
    scope: "account_global",
    collectorVersion: "test",
    accounts: [{
      accountKey: "a".repeat(64),
      health: "ok",
      windows: [{ id: "primary", label: "5 hours", status: "parse_unavailable" }],
    }],
  };
}

test("runtime account usage drops scheduled refresh and snapshot ingest from raw or unattached connections", async () => {
  for (const scenario of [
    { machineId: "legacy-machine", principalKind: "legacy_machine" as const, attachedBy: "user-1" },
    { machineId: "unknown-machine", principalKind: "unknown" as const, attachedBy: "user-1" },
    { machineId: "unattached-computer", principalKind: "computer" as const, attachedBy: null },
  ]) {
    const orchestrator = new RuntimeAccountUsageBoundaryDeterministicOrchestrator();
    orchestrator.seedRuntimeUsageConnection(scenario.machineId, scenario.principalKind);
    if (scenario.attachedBy) orchestrator.attachedByMachine.set(scenario.machineId, scenario.attachedBy);

    await orchestrator.collectRuntimeAccountUsageForTest(scenario.machineId);
    await orchestrator.handleMachineMessage(scenario.machineId, {
      type: "machine:runtime_account_usage:snapshot",
      snapshot: runtimeAccountUsageBoundarySnapshot(),
    } as MachineToServerMessage);

    assert.deepEqual(orchestrator.refreshRequests, [], `${scenario.machineId} must not receive refresh`);
    assert.deepEqual(orchestrator.cachedSnapshots, [], `${scenario.machineId} snapshot must be dropped`);
    orchestrator.shutdown();
  }
});

test("runtime account usage allows attached Computer collection and ingest when the server gate is on", async () => {
  const orchestrator = new RuntimeAccountUsageBoundaryDeterministicOrchestrator();
  orchestrator.seedRuntimeUsageConnection("attached-computer", "computer");
  orchestrator.attachedByMachine.set("attached-computer", "user-1");
  const snapshot = runtimeAccountUsageBoundarySnapshot();

  await orchestrator.collectRuntimeAccountUsageForTest("attached-computer");
  await orchestrator.handleMachineMessage("attached-computer", {
    type: "machine:runtime_account_usage:snapshot",
    snapshot,
  } as MachineToServerMessage);

  assert.deepEqual(orchestrator.refreshRequests, [{ machineId: "attached-computer", provider: "codex" }]);
  assert.deepEqual(orchestrator.cachedSnapshots, [{ machineId: "attached-computer", snapshot }]);
  orchestrator.shutdown();
});

function startHeartbeat(orchestrator: AgentOrchestrator, machineId: string, conn: unknown) {
  (orchestrator as any).startMachineHeartbeat(machineId, conn);
}

function makeFakeWs(readyState = 1) {
  return {
    readyState,
    sent: [] as string[],
    terminated: 0,
    closed: 0,
    closeArgs: [] as Array<{ code?: number; reason?: string }>,
    send(data: string) {
      this.sent.push(data);
    },
    terminate() {
      this.terminated += 1;
      this.readyState = 3;
    },
    close(code?: number, reason?: string) {
      this.closed += 1;
      this.closeArgs.push({ code, reason });
      this.readyState = 3;
    },
  };
}

function makeFakeServerIO(captured: Array<{ room: string; event: string; payload: unknown }>) {
  return {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          captured.push({ room, event, payload });
        },
      };
    },
  };
}

class JointActivityFanoutDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  readonly emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  readonly projectionLookups: Array<{ agentId: string; sourceServerId: string }> = [];

  constructor(private readonly projectionChannelIds: string[]) {
    super();
    (this as unknown as { io: ReturnType<typeof makeFakeServerIO> }).io = makeFakeServerIO(this.emitted);
  }

  protected override async loadJointActivityProjectionChannelIdsForAgent(agentId: string, sourceServerId: string): Promise<string[]> {
    this.projectionLookups.push({ agentId, sourceServerId });
    return this.projectionChannelIds;
  }
}

function seedActiveAgent(orchestrator: AgentOrchestrator, agentId = "agent-1", machineId = "machine-1", runtime = "codex") {
  (orchestrator as any).agentStateCache.set(agentId, {
    id: agentId,
    status: "active",
    machineId,
    sessionId: null,
    expectedLaunchId: null,
    launchGuardMode: "legacy",
    serverId: "server-1",
    name: "agent-1",
    displayName: null,
    description: null,
    model: "gpt-5",
    runtime,
    lastRuntimeError: null,
    runtimeState: "running_idle",
    reasoningEffort: null,
    envVars: null,
  });
}

function seedRuntimeErrorState(
  orchestrator: AgentOrchestrator,
  agentId = "agent-1",
  message = "Built-in provider authentication failed",
  launchId: string | null = "launch-auth",
) {
  (orchestrator as any).updateCache(agentId, {
    lastRuntimeError: {
      message,
      at: new Date(0).toISOString(),
      launchId,
      actionRequired: true,
    },
  });
  (orchestrator as any).agentActivity.set(agentId, {
    activity: "error",
    detail: message,
    updatedAt: 0,
  });
}

function makeMachineRecord(machineId = "machine-1") {
  return {
    id: machineId,
    serverId: "server-1",
    userId: "user-1",
    name: "machine-1",
    description: null,
    apiKeyPrefix: null,
    runtimes: null as string[] | null,
    hostname: null as string | null,
    os: null as string | null,
    daemonVersion: null as string | null,
    lastHeartbeat: null as Date | null,
    createdAt: new Date(0),
  };
}

function makeAgentMessage(content: string, seq = 1): AgentMessage {
  return {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    message_id: `msg-${seq}`,
    sender_id: "user-1",
    sender_name: "richard",
    sender_type: "human",
    content,
    seq,
    timestamp: new Date(0).toISOString(),
  };
}

function makeDeterministicTracer() {
  let spanIndex = 0;
  const traceId = "1".repeat(32);
  const spanIds = ["2".repeat(16), "3".repeat(16), "4".repeat(16)];
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => traceId,
    spanIdGenerator: () => spanIds[spanIndex++] ?? "5".repeat(16),
  });
  return { sink, tracer, traceId };
}

const TRACE_EVENT_ROW_TEST_RESOURCE = {
  serviceName: "slock-server",
  deploymentEnvironment: "test",
};

function traceEventRowsForSpanName(sink: MemoryTraceSink, traceId: string, spanName: string) {
  const span = sink.getTrace(traceId).find((entry) => entry.name === spanName);
  assert.ok(span, `expected span ${spanName}`);
  return traceEventRowsForSpan(span, TRACE_EVENT_ROW_TEST_RESOURCE);
}

function traceSpanFactRowForSpanName(sink: MemoryTraceSink, traceId: string, spanName: string) {
  const span = sink.getTrace(traceId).find((entry) => entry.name === spanName);
  assert.ok(span, `expected span ${spanName}`);
  return traceSpanFactRowForSpan(span, TRACE_EVENT_ROW_TEST_RESOURCE);
}

function lifecycleProjectionAttrs(sink: MemoryTraceSink, traceId: string) {
  return sink.getTrace(traceId)
    .flatMap((span) => span.events)
    .filter((event) => event.name === "agent.lifecycle.projection")
    .map((event) => event.attrs ?? {});
}

function assertResolveSpanAgentIdentity(
  sink: MemoryTraceSink,
  traceId: string,
  agentId: string,
  source: string,
) {
  // `server.agent.activity.resolve` is a single-agent span per getActivity(agentId).
  // If it ever covers multiple agents, raw identity belongs on each event instead.
  const span = sink.getTrace(traceId).find((entry) =>
    entry.name === "server.agent.activity.resolve" && entry.attrs?.source === source);
  assert.ok(span, `missing activity.resolve span for source ${source}`);
  assert.equal(span.attrs?.agent_id, agentId);
  assert.equal(span.attrs?.agent_id_present, true);
}

function recentLifecycleEvents(orchestrator: AgentOrchestrator, agentId = "agent-1") {
  return orchestrator.getRecentLifecycleEvents(agentId, 20).map(({ at, ...event }: AgentLifecycleEvent) => event);
}

function recentLifecycleEventsWithTimestamps(orchestrator: AgentOrchestrator, agentId = "agent-1") {
  return orchestrator.getRecentLifecycleEvents(agentId, 20);
}

test("cross-replica active agent stays online when machine replica heartbeat still exists", async () => {
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");

  const orchestrator = new DeterministicAgentOrchestrator(store);
  seedActiveAgent(orchestrator);

  const activity = await orchestrator.getActivity("agent-1");
  assert.deepEqual(activity, { activity: "online", activityDetail: "" });

  orchestrator.shutdown();
});

test("joint channel agent activity is emitted to sibling projection channel rooms", async () => {
  const orchestrator = new JointActivityFanoutDeterministicOrchestrator([
    "host-projection-channel",
    "target-projection-channel",
  ]);
  seedActiveAgent(orchestrator, "third-server-agent", "machine-3");
  (orchestrator as any).agentStateCache.get("third-server-agent").serverId = "third-server";

  await (orchestrator as any).emitActivity(
    "third-server-agent",
    "working",
    "Working",
    "runtime_progress",
    123,
  );

  assert.deepEqual(orchestrator.projectionLookups, [
    { agentId: "third-server-agent", sourceServerId: "third-server" },
  ]);
  assert.deepEqual(
    orchestrator.emitted.map((event) => ({ room: event.room, event: event.event })),
    [
      { room: "server:third-server", event: "agent:activity" },
      { room: "channel:host-projection-channel", event: "agent:activity" },
      { room: "channel:target-projection-channel", event: "agent:activity" },
    ],
  );
  assert.deepEqual(
    orchestrator.emitted.map((event) => (event.payload as { agentId: string }).agentId),
    ["third-server-agent", "third-server-agent", "third-server-agent"],
  );

  orchestrator.shutdown();
});

test("runtime profile heartbeat nudge planner supports kill switch and hard cooldown", () => {
  assert.equal(planRuntimeProfileHeartbeatNudgeAction({
    disabled: true,
    lastSentAt: null,
    now: 10_000,
    cooldownMs: 24 * 60 * 60_000,
  }), "disabled");

  assert.equal(planRuntimeProfileHeartbeatNudgeAction({
    disabled: false,
    lastSentAt: 1_000,
    now: 60_000,
    cooldownMs: 24 * 60 * 60_000,
  }), "cooldown");

  assert.equal(planRuntimeProfileHeartbeatNudgeAction({
    disabled: false,
    lastSentAt: 1_000,
    now: 1_000 + 24 * 60 * 60_000,
    cooldownMs: 24 * 60 * 60_000,
  }), "allow");

  assert.equal(planRuntimeProfileHeartbeatNudgeAction({
    disabled: false,
    lastSentAt: null,
    now: 10_000,
    cooldownMs: 24 * 60 * 60_000,
  }), "allow");
});

test("heartbeat runtime profile nudge path honors kill switch before daemon send", async () => {
  const previousDisable = process.env.SLOCK_DISABLE_MIGRATION_NUDGE_PIGGYBACK;
  const previousCooldown = process.env.SLOCK_MIGRATION_NUDGE_PIGGYBACK_COOLDOWN_MS;
  process.env.SLOCK_DISABLE_MIGRATION_NUDGE_PIGGYBACK = "true";
  delete process.env.SLOCK_MIGRATION_NUDGE_PIGGYBACK_COOLDOWN_MS;

  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), clock, tracer);
  const ws = makeFakeWs();
  try {
    seedActiveAgent(orchestrator, "agent-1", "machine-1");
    seedMachineConnection(orchestrator, "machine-1", ws);

    await orchestrator.handleMachineMessage("machine-1", { type: "pong" } as MachineToServerMessage);

    const span = sink.getTrace(traceId).find((entry) => entry.name === "server.runtime_profile.heartbeat_nudge.scan");
    assert.ok(span);
    assert.equal(span.attrs?.disabled, true);
    assert.equal(span.attrs?.active_agents_count, 1);
    assert.equal(span.attrs?.disabled_count, 1);
    assert.equal(span.attrs?.sent_count, 0);
    assert.equal(ws.sent.length, 0);
  } finally {
    if (previousDisable === undefined) {
      delete process.env.SLOCK_DISABLE_MIGRATION_NUDGE_PIGGYBACK;
    } else {
      process.env.SLOCK_DISABLE_MIGRATION_NUDGE_PIGGYBACK = previousDisable;
    }
    if (previousCooldown === undefined) {
      delete process.env.SLOCK_MIGRATION_NUDGE_PIGGYBACK_COOLDOWN_MS;
    } else {
      process.env.SLOCK_MIGRATION_NUDGE_PIGGYBACK_COOLDOWN_MS = previousCooldown;
    }
    orchestrator.shutdown();
  }
});

test("adoption principal fence closes only the legacy socket and preserves a Computer replacement", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  const legacyWs = makeFakeWs();

  await orchestrator.registerMachine(
    "machine-1",
    "server-1",
    legacyWs as never,
    undefined,
    "legacy_machine",
  );
  assert.equal(
    await orchestrator.fenceMachinePrincipalConnections("machine-1", "legacy_machine"),
    true,
  );
  assert.deepEqual(legacyWs.closeArgs.at(-1), {
    code: 4002,
    reason: "legacy_machine_key_migrated",
  });

  const computerWs = makeFakeWs();
  await orchestrator.registerMachine(
    "machine-1",
    "server-1",
    computerWs as never,
    undefined,
    "computer",
  );
  assert.equal(
    await orchestrator.fenceMachinePrincipalConnections("machine-1", "legacy_machine"),
    false,
  );
  assert.equal(computerWs.closed, 0, "legacy fence must never close the Computer principal");

  await orchestrator.shutdown();
});

test("pre-CAS legacy auth cannot finish registration after the adoption fence", async () => {
  const orchestrator = new DeferredLegacyFenceOrchestrator();
  const legacyWs = makeFakeWs();
  const registration = orchestrator.registerMachine(
    "machine-1",
    "server-1",
    legacyWs as never,
    undefined,
    "legacy_machine",
  );

  await orchestrator.secondValidationEntered.promise;
  assert.equal(
    (orchestrator as unknown as { machineConnections: Map<string, unknown> })
      .machineConnections.has("machine-1"),
    true,
    "connection must be visible during the post-register validation window",
  );

  await orchestrator.fenceMachinePrincipalConnections("machine-1", "legacy_machine");
  orchestrator.secondValidationGate.resolve(false);
  await registration;

  assert.equal(
    (orchestrator as unknown as { machineConnections: Map<string, unknown> })
      .machineConnections.has("machine-1"),
    false,
  );
  assert.deepEqual(legacyWs.closeArgs.at(-1), {
    code: 4002,
    reason: "legacy_machine_key_migrated",
  });

  await orchestrator.shutdown();
});

test("buffered messages from a replaced legacy socket cannot act through the Computer connection", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  const legacyWs = makeFakeWs();
  const computerWs = makeFakeWs();

  await orchestrator.registerMachine(
    "machine-1",
    "server-1",
    computerWs as never,
    undefined,
    "computer",
  );
  await orchestrator.handleMachineMessage(
    "machine-1",
    { type: "ping" } as MachineToServerMessage,
    legacyWs as never,
  );
  assert.deepEqual(computerWs.sent, [], "stale socket input must be dropped before dispatch");

  await orchestrator.handleMachineMessage(
    "machine-1",
    { type: "ping" } as MachineToServerMessage,
    computerWs as never,
  );
  assert.deepEqual(JSON.parse(computerWs.sent.at(-1) ?? "{}"), { type: "ping" });

  await orchestrator.shutdown();
});

test("machine websocket heartbeat suppresses normal ping and pong traces", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), clock, tracer);
  const ws = makeFakeWs(1);

  await orchestrator.registerMachine("machine-1", "server-1", ws as never);
  clock.advance(30_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(ws.sent[0] ?? "{}"), { type: "ping" });
  assert.equal(
    sink.getTrace(traceId).some((span) => span.name === "server.machine.websocket.heartbeat"),
    false,
  );

  await orchestrator.handleMachineMessage("machine-1", { type: "pong" } as MachineToServerMessage);
  assert.equal(
    sink.getTrace(traceId).some((span) => span.name === "server.machine.websocket.pong_received"),
    false,
  );

  orchestrator.shutdown();
});

test("daemon-initiated ping is echoed so idle links can satisfy the inbound watchdog", async () => {
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), clock);
  const ws = makeFakeWs();

  await orchestrator.registerMachine("machine-1", "server-1", ws as never);
  await orchestrator.handleMachineMessage("machine-1", { type: "ping" } as MachineToServerMessage);

  assert.deepEqual(JSON.parse(ws.sent.at(-1) ?? "{}"), { type: "ping" });

  orchestrator.shutdown();
});

test("machine websocket heartbeat timeout traces stale pong age before terminating", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), clock, tracer);
  const ws = makeFakeWs(1);

  await orchestrator.registerMachine("machine-1", "server-1", ws as never);
  clock.advance(90_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ws.terminated, 1);
  const timeoutSpan = sink.getTrace(traceId).find((span) =>
    span.name === "server.machine.websocket.heartbeat" && span.attrs?.outcome === "heartbeat_timeout"
  );
  assert.ok(timeoutSpan);
  assert.equal(timeoutSpan.status, "error");
  assert.equal(timeoutSpan.attrs?.last_pong_age_ms_bucket, "60s-120s");
  assert.equal(timeoutSpan.attrs?.terminated_socket, true);
  assert.equal(
    timeoutSpan.events.some((event) => event.name === "heartbeat.timeout" && event.attrs?.last_pong_age_ms_bucket === "60s-120s"),
    true,
  );
  const [timeoutRow] = traceEventRowsForSpanName(sink, traceId, "server.machine.websocket.heartbeat")
    .filter((row) => row.event_name === "heartbeat.timeout");
  assert.ok(timeoutRow);
  assert.equal(timeoutRow.machine_id, "machine-1");
  assert.equal(timeoutRow.server_id, "server-1");
  assert.equal(timeoutRow.outcome, "heartbeat_timeout");
  assert.equal(timeoutRow.reason, "heartbeat_timeout");
  const heartbeatTimerFact = traceSpanFactRowForSpanName(sink, traceId, "server.machine.websocket.heartbeat_timer");
  assert.equal(heartbeatTimerFact.row_kind, "span_fact");
  assert.equal(heartbeatTimerFact.event_name, "server.machine.websocket.heartbeat_timer");
  assert.equal(heartbeatTimerFact.event_index, null);
  assert.equal(heartbeatTimerFact.machine_id, "machine-1");
  assert.equal(heartbeatTimerFact.server_id, "server-1");
  assert.equal(heartbeatTimerFact.outcome, "started");

  orchestrator.shutdown();
});

test("machine websocket pong failure span fact carries machine axes", async () => {
  class FailingHeartbeatPersistOrchestrator extends DeterministicAgentOrchestrator {
    protected override async updateMachineHeartbeat(_machineId: string) {
      throw new Error("heartbeat persist failed");
    }
  }

  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new FailingHeartbeatPersistOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", { type: "pong" } as MachineToServerMessage);

  const pongFact = traceSpanFactRowForSpanName(sink, traceId, "server.machine.websocket.pong_received");
  assert.equal(pongFact.row_kind, "span_fact");
  assert.equal(pongFact.event_name, "server.machine.websocket.pong_received");
  assert.equal(pongFact.event_index, null);
  assert.equal(pongFact.span_status, "error");
  assert.equal(pongFact.machine_id, "machine-1");
  assert.equal(pongFact.server_id, "server-1");
  assert.equal(pongFact.outcome, "heartbeat_persist_failed");

  orchestrator.shutdown();
});

test("runtime profile gated inbox flush emits trace and propagates delivery context", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);
  const ws = makeFakeWs(1);
  try {
    seedActiveAgent(orchestrator, "agent-1", "machine-1");
    seedMachineConnection(orchestrator, "machine-1", ws);
    (orchestrator as any).agentInboxes.set("agent-1", {
      inbox: [makeAgentMessage("flush after runtime profile migration done", 42)],
      pendingReceive: null,
    });

    const agent = { ...(orchestrator as any).agentStateCache.get("agent-1"), id: "agent-1" };
    await (orchestrator as any).flushRuntimeProfileGatedInbox("machine-1", agent);

    const span = sink.getTrace(traceId).find((entry) => entry.name === "server.runtime_profile.gated_inbox.flush");
    assert.ok(span);
    assert.equal(span.attrs?.agent_id_present, true);
    assert.equal(span.attrs?.machine_id_present, true);
    assert.equal(span.attrs?.inbox_count, 1);
    assert.equal(typeof span.attrs?.oldest_message_age_ms, "number");
    assert.equal(span.attrs?.oldest_message_age_bucket, "120s+");
    assert.equal(span.attrs?.sent_count, 1);
    assert.equal(span.attrs?.send_failed_count, 0);
    const spanFact = traceSpanFactRowForSpanName(sink, traceId, "server.runtime_profile.gated_inbox.flush");
    assert.equal(spanFact.event_kind, "runtime_profile");
    assert.equal(spanFact.agent_id, "agent-1");
    assert.equal(spanFact.machine_id, "machine-1");
    assert.equal(spanFact.server_id, "server-1");
    assert.equal(spanFact.outcome, "sent");
    assert.equal(spanFact.reason, "gated_inbox_flushed");
    const delivered = JSON.parse(ws.sent[0] ?? "{}") as Extract<ServerToMachineMessage, { type: "agent:deliver" }>;
    assert.equal(delivered.type, "agent:deliver");
    assert.equal(delivered.seq, 42);
    const parent = parseTraceparent(delivered.traceparent);
    assert.ok(parent);
    assert.equal(parent.traceId, traceId);
    assert.equal(parent.spanId, span.context.spanId);
  } finally {
    orchestrator.shutdown();
  }
});

test("machine status resolves offline when DB could be stale but no local or remote reachability exists", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();

  assert.equal(await orchestrator.getMachineStatus("machine-1"), "offline");

  orchestrator.shutdown();
});

test("machine status resolves online from remote replica reachability even without a local connection", async () => {
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  const orchestrator = new DeterministicAgentOrchestrator(store);

  assert.equal(await orchestrator.getMachineStatus("machine-1"), "online");

  orchestrator.shutdown();
});

test("same-replica reconnect handoff keeps remote machine status online even if the stale unregister resolves last", async () => {
  const shared = new ControlledReplicaState();
  const replicaAStore = new ControlledReplicaStateStore(shared, "replica-a");
  const replicaBStore = new ControlledReplicaStateStore(shared, "replica-b");
  const replicaA = new DeterministicAgentOrchestrator(replicaAStore);
  const replicaB = new DeterministicAgentOrchestrator(replicaBStore);

  await replicaA.registerMachine("machine-1", "server-1", makeFakeWs() as never);
  await flushMicrotasks();
  assert.equal(await replicaB.getMachineStatus("machine-1"), "online");

  const staleUnregister = shared.deferNextMachineMutation({
    type: "unregister",
    machineId: "machine-1",
    replicaId: "replica-a",
  });
  const freshRegister = shared.deferNextMachineMutation({
    type: "register",
    machineId: "machine-1",
    replicaId: "replica-a",
  });

  // The reconnect now awaits the replica owner commit before returning (owner is
  // committed before the online event is emitted), so resolve the gated register
  // concurrently instead of after awaiting registerMachine.
  const reconnect = replicaA.registerMachine("machine-1", "server-1", makeFakeWs() as never);
  freshRegister.resolve();
  await reconnect;
  await flushMicrotasks();
  assert.equal(await replicaB.getMachineStatus("machine-1"), "online");

  staleUnregister.resolve();
  await flushMicrotasks();
  assert.equal(await replicaB.getMachineStatus("machine-1"), "online");

  replicaA.shutdown();
  replicaB.shutdown();
});

test("same-replica reconnect handoff keeps remote start routable even if the stale unregister resolves last", async () => {
  const shared = new ControlledReplicaState();
  const network: StartRoutingNetwork = { shared, replicas: new Map() };
  const replicaA = new StartRoutingDeterministicOrchestrator(
    "replica-a",
    network,
    new ControlledReplicaStateStore(shared, "replica-a"),
  );
  const replicaB = new StartRoutingDeterministicOrchestrator(
    "replica-b",
    network,
    new ControlledReplicaStateStore(shared, "replica-b"),
  );

  await replicaA.registerMachine("machine-1", "server-1", makeFakeWs() as never);
  await flushMicrotasks();

  const staleUnregister = shared.deferNextMachineMutation({
    type: "unregister",
    machineId: "machine-1",
    replicaId: "replica-a",
  });
  const freshRegister = shared.deferNextMachineMutation({
    type: "register",
    machineId: "machine-1",
    replicaId: "replica-a",
  });

  // The reconnect now awaits the replica owner commit before returning (owner is
  // committed before the online event is emitted), so resolve the gated register
  // concurrently instead of after awaiting registerMachine.
  const reconnect = replicaA.registerMachine("machine-1", "server-1", makeFakeWs() as never);
  freshRegister.resolve();
  await reconnect;
  await flushMicrotasks();
  staleUnregister.resolve();
  await flushMicrotasks();

  await assert.doesNotReject(() => replicaB.startAgent("agent-1"));

  replicaA.shutdown();
  replicaB.shutdown();
});

test("cross-replica ownership transfer keeps remote machine status online even if the previous owner unregister resolves last", async () => {
  const shared = new ControlledReplicaState();
  const replicaA = new DeterministicAgentOrchestrator(new ControlledReplicaStateStore(shared, "replica-a"));
  const replicaB = new DeterministicAgentOrchestrator(new ControlledReplicaStateStore(shared, "replica-b"));
  const replicaC = new DeterministicAgentOrchestrator(new ControlledReplicaStateStore(shared, "replica-c"));

  await replicaA.registerMachine("machine-1", "server-1", makeFakeWs() as never);
  await flushMicrotasks();
  assert.equal(await replicaC.getMachineStatus("machine-1"), "online");

  const staleUnregister = shared.deferNextMachineMutation({
    type: "unregister",
    machineId: "machine-1",
    replicaId: "replica-a",
  });
  const freshRegister = shared.deferNextMachineMutation({
    type: "register",
    machineId: "machine-1",
    replicaId: "replica-b",
  });

  const staleUnregisterTask = replicaA.unregisterMachine("machine-1");
  // registerMachine awaits the replica owner commit before emitting online, so
  // resolve the gated register concurrently instead of after awaiting it.
  const reconnect = replicaB.registerMachine("machine-1", "server-1", makeFakeWs() as never);
  freshRegister.resolve();
  await reconnect;
  await flushMicrotasks();
  assert.equal(await replicaC.getMachineStatus("machine-1"), "online");

  staleUnregister.resolve();
  await staleUnregisterTask;
  await flushMicrotasks();
  assert.equal(await replicaC.getMachineStatus("machine-1"), "online");

  replicaA.shutdown();
  replicaB.shutdown();
  replicaC.shutdown();
});

test("machine online status event is not emitted before the replica owner mapping is committed", async () => {
  // Repro of #wg-raft-computer task #89 / #proj-o11y cross-replica status latch:
  // web socket on replica B, machine (re)connects on replica A. The frontend's
  // authoritative reloadMachines REST is triggered by RECEIPT of the online
  // status event; the soonest such REST can land on replica B and call
  // getMachineStatus, which resolves cross-replica reachability from the shared
  // machine->replica owner mapping. If the online event is emitted BEFORE that
  // owner mapping is committed, the earliest cross-replica read returns offline,
  // and the web client (which has no repair/re-poll loop) latches offline until a
  // manual refresh — exactly the "restart -> offline -> never auto online" symptom.
  //
  // Invariant: the machine:status online event must not be observable before the
  // owner mapping that other replicas read is committed.
  const shared = new ControlledReplicaState();
  const replicaA = new DeterministicAgentOrchestrator(new ControlledReplicaStateStore(shared, "replica-a"));
  const replicaB = new DeterministicAgentOrchestrator(new ControlledReplicaStateStore(shared, "replica-b"));

  // Snapshot, at the exact moment the online event is emitted, what a
  // cross-replica reloadMachines REST on replica B would resolve.
  let crossReplicaStatusAtOnlineEmit: "online" | "offline" | "__unset__" = "__unset__";
  let onlineEmitCount = 0;
  const io = {
    to: (_room: string) => ({
      emit: (event: string, payload: unknown) => {
        if (event === "machine:status" && (payload as { status: string }).status === "online") {
          onlineEmitCount += 1;
          const owner = shared.machineOwners.get("machine-1") ?? null;
          crossReplicaStatusAtOnlineEmit = owner ? "online" : "offline";
        }
      },
    }),
  };
  replicaA.setIO(io as never);

  try {
    await replicaA.registerMachine("machine-1", "server-1", makeFakeWs() as never);
    await flushMicrotasks();

    assert.equal(onlineEmitCount, 1);
    // RED before fix (owner not yet committed -> "offline"); GREEN after fix.
    assert.equal(crossReplicaStatusAtOnlineEmit, "online");
    // Sanity: once settled, replica B resolves the machine as online.
    assert.equal(await replicaB.getMachineStatus("machine-1"), "online");
  } finally {
    replicaA.shutdown();
    replicaB.shutdown();
  }
});

test("failed replica owner registration closes the socket and never surfaces false readiness", async () => {
  const orchestrator = new DeterministicAgentOrchestrator(new RejectingRegisterReplicaStateStore());
  const ws = makeFakeWs();
  let onlineEmitCount = 0;
  orchestrator.setIO({
    to: () => ({
      emit: (event: string, payload: unknown) => {
        if (event === "machine:status" && (payload as { status?: string }).status === "online") {
          onlineEmitCount += 1;
        }
      },
    }),
  } as never);

  await orchestrator.registerMachine("machine-1", "server-1", ws as never);

  assert.equal(onlineEmitCount, 0);
  assert.deepEqual(ws.closeArgs.at(-1), {
    code: 1011,
    reason: "replica_registration_failed",
  });
  assert.equal(
    (orchestrator as unknown as { machineConnections: Map<string, unknown> })
      .machineConnections.has("machine-1"),
    false,
  );
  orchestrator.shutdown();
});

test("a missing replica registration receipt closes the socket and never surfaces false readiness", async () => {
  const orchestrator = new DeterministicAgentOrchestrator(new MissingReceiptReplicaStateStore());
  const ws = makeFakeWs();
  let onlineEmitCount = 0;
  orchestrator.setIO({
    to: () => ({
      emit: (event: string, payload: unknown) => {
        if (event === "machine:status" && (payload as { status?: string }).status === "online") {
          onlineEmitCount += 1;
        }
      },
    }),
  } as never);

  await orchestrator.registerMachine("machine-1", "server-1", ws as never);

  assert.equal(onlineEmitCount, 0);
  assert.deepEqual(ws.closeArgs.at(-1), {
    code: 1011,
    reason: "replica_registration_failed",
  });
  assert.equal(orchestrator.hasMachineLocally("machine-1"), false);
  orchestrator.shutdown();
});

test("a pending owner registration is not locally request-ready until its receipt commits", async () => {
  const store = new SupersededSuccessfulRegisterReplicaStateStore();
  const orchestrator = new DeterministicAgentOrchestrator(store);
  const ws = makeFakeWs();

  const registration = orchestrator.registerMachine("machine-1", "server-1", ws as never);
  await store.firstRegisterEntered.promise;
  assert.equal(orchestrator.hasMachineLocally("machine-1"), false);

  store.releaseFirstRegister.resolve();
  await registration;
  assert.equal(orchestrator.hasMachineLocally("machine-1"), true);
  orchestrator.shutdown();
});

test("a stale registration failure cannot close its successful successor connection", async () => {
  const store = new SupersededRejectingRegisterReplicaStateStore();
  const orchestrator = new DeterministicAgentOrchestrator(store);
  const firstWs = makeFakeWs();
  const successorWs = makeFakeWs();

  const firstRegistration = orchestrator.registerMachine("machine-1", "server-1", firstWs as never);
  await store.firstRegisterEntered.promise;
  await orchestrator.registerMachine("machine-1", "server-1", successorWs as never);

  store.releaseFirstRegister.resolve();
  await firstRegistration;

  assert.equal(successorWs.closed, 0);
  assert.equal(orchestrator.hasMachineLocally("machine-1"), true);
  assert.equal(
    (orchestrator as unknown as { machineConnections: Map<string, { ws: unknown }> })
      .machineConnections.get("machine-1")?.ws,
    successorWs,
  );
  orchestrator.shutdown();
});

test("a stale successful registration recommits the active successor generation", async () => {
  const store = new SupersededSuccessfulRegisterReplicaStateStore();
  const orchestrator = new DeterministicAgentOrchestrator(store);
  const firstWs = makeFakeWs();
  const successorWs = makeFakeWs();
  let onlineEmitCount = 0;
  orchestrator.setIO({
    to: () => ({
      emit: (event: string, payload: unknown) => {
        if (event === "machine:status" && (payload as { status?: string }).status === "online") {
          onlineEmitCount += 1;
        }
      },
    }),
  } as never);

  const firstRegistration = orchestrator.registerMachine("machine-1", "server-1", firstWs as never);
  await store.firstRegisterEntered.promise;
  await orchestrator.registerMachine("machine-1", "server-1", successorWs as never);

  store.releaseFirstRegister.resolve();
  await firstRegistration;

  const active = (orchestrator as unknown as {
    machineConnections: Map<string, { ws: unknown; replicaGeneration: string | null }>;
  }).machineConnections.get("machine-1");
  assert.equal(store.registerCalls, 3, "the stale commit is followed by one active-owner recommit");
  assert.equal(active?.ws, successorWs);
  assert.equal(active?.replicaGeneration, "generation-3");
  assert.equal(successorWs.closed, 0);
  assert.equal(onlineEmitCount, 1, "the stale registration must not emit a second online event");
  orchestrator.shutdown();
});

test("disconnect during stale-registration recommit cleans the exact orphaned generation", async () => {
  const store = new DisconnectDuringRecommitReplicaStateStore();
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(store, clock);
  const firstWs = makeFakeWs();
  const successorWs = makeFakeWs();

  const firstRegistration = orchestrator.registerMachine("machine-1", "server-1", firstWs as never);
  await store.firstRegisterEntered.promise;
  await orchestrator.registerMachine("machine-1", "server-1", successorWs as never);

  store.releaseFirstRegister.resolve();
  await store.thirdRegisterEntered.promise;
  await orchestrator.handleMachineDisconnect("machine-1", successorWs as never, { cause: "socket_close" });
  clock.advance(2_000);
  await waitForCondition(() => store.unregisterGenerations.includes("generation-2"));

  store.releaseThirdRegister.resolve();
  await firstRegistration;
  await waitForCondition(() => store.unregisterGenerations.includes("generation-3"));

  assert.equal(orchestrator.hasMachineLocally("machine-1"), false);
  assert.equal(store.machineReplicaGenerations.has("machine-1"), false);
  assert.equal(store.machineReplicaOwners.has("machine-1"), false);
  orchestrator.shutdown();
});

test("replacement during stale-registration recommit restores the exact active generation", async () => {
  const store = new DisconnectDuringRecommitReplicaStateStore();
  const orchestrator = new DeterministicAgentOrchestrator(store);
  const firstWs = makeFakeWs();
  const successorWs = makeFakeWs();
  const replacementWs = makeFakeWs();

  const firstRegistration = orchestrator.registerMachine("machine-1", "server-1", firstWs as never);
  await store.firstRegisterEntered.promise;
  await orchestrator.registerMachine("machine-1", "server-1", successorWs as never);

  store.releaseFirstRegister.resolve();
  await store.thirdRegisterEntered.promise;
  await orchestrator.registerMachine("machine-1", "server-1", replacementWs as never);
  assert.equal(store.machineReplicaGenerations.get("machine-1"), "generation-4");

  store.releaseThirdRegister.resolve();
  await firstRegistration;

  const active = (orchestrator as unknown as {
    machineConnections: Map<string, { ws: unknown; replicaGeneration: string | null }>;
  }).machineConnections.get("machine-1");
  assert.equal(active?.ws, replacementWs);
  assert.equal(active?.replicaGeneration, "generation-4");
  assert.equal(store.machineReplicaOwners.get("machine-1"), REPLICA_ID);
  assert.equal(store.machineReplicaGenerations.get("machine-1"), "generation-4");
  orchestrator.shutdown();
});

test("cross-replica ownership transfer keeps remote start routable even if the previous owner unregister resolves last", async () => {
  const shared = new ControlledReplicaState();
  const network: StartRoutingNetwork = { shared, replicas: new Map() };
  const replicaA = new StartRoutingDeterministicOrchestrator(
    "replica-a",
    network,
    new ControlledReplicaStateStore(shared, "replica-a"),
  );
  const replicaB = new StartRoutingDeterministicOrchestrator(
    "replica-b",
    network,
    new ControlledReplicaStateStore(shared, "replica-b"),
  );
  const replicaC = new StartRoutingDeterministicOrchestrator(
    "replica-c",
    network,
    new ControlledReplicaStateStore(shared, "replica-c"),
  );

  await replicaA.registerMachine("machine-1", "server-1", makeFakeWs() as never);
  await flushMicrotasks();

  const staleUnregister = shared.deferNextMachineMutation({
    type: "unregister",
    machineId: "machine-1",
    replicaId: "replica-a",
  });
  const freshRegister = shared.deferNextMachineMutation({
    type: "register",
    machineId: "machine-1",
    replicaId: "replica-b",
  });

  const staleUnregisterTask = replicaA.unregisterMachine("machine-1");
  // registerMachine awaits the replica owner commit before emitting online, so
  // resolve the gated register concurrently instead of after awaiting it.
  const reconnect = replicaB.registerMachine("machine-1", "server-1", makeFakeWs() as never);
  freshRegister.resolve();
  await reconnect;
  await flushMicrotasks();
  assert.equal(await replicaC.getMachineStatus("machine-1"), "online");

  staleUnregister.resolve();
  await staleUnregisterTask;
  await flushMicrotasks();

  await assert.doesNotReject(() => replicaC.startAgent("agent-1"));

  replicaA.shutdown();
  replicaB.shutdown();
  replicaC.shutdown();
});

test("queued-start retry transfers ownership across replicas after machine reconnect", async () => {
  const clock = new FakeClock();
  const shared = new ControlledReplicaState();
  const network: StartRoutingNetwork = { shared, replicas: new Map() };
  const replicaA = new StartRoutingDeterministicOrchestrator(
    "replica-a",
    network,
    new ControlledReplicaStateStore(shared, "replica-a"),
    clock,
  );
  const replicaB = new StartRoutingDeterministicOrchestrator(
    "replica-b",
    network,
    new ControlledReplicaStateStore(shared, "replica-b"),
    clock,
  );
  const replicaC = new StartRoutingDeterministicOrchestrator(
    "replica-c",
    network,
    new ControlledReplicaStateStore(shared, "replica-c"),
    clock,
  );
  seedActiveAgent(replicaA);
  seedActiveAgent(replicaB);
  seedActiveAgent(replicaC);
  const staleWs = makeFakeWs(1);
  await replicaA.registerMachine("machine-1", "server-1", staleWs as never);

  await replicaC.startAgent("agent-1");
  await flushMicrotasks(10);
  const first = JSON.parse(staleWs.sent[0] ?? "{}") as Extract<
    ServerToMachineMessage,
    { type: "agent:start" }
  > & { startDispatchId: string };
  assert.ok(first.startDispatchId);
  assert.equal((replicaA as any).pendingAgentStartAcks.has(first.startDispatchId), true);

  await replicaA.unregisterMachine("machine-1");
  clock.advance(5_000);
  await flushMicrotasks(20);
  const parked = (replicaA as any).pendingAgentStartAcks.get(first.startDispatchId);
  assert.ok(parked);
  assert.equal(parked.parked, true);
  assert.equal(parked.attempts, 1, "offline ownership probes must not consume attempts");

  const freshWs = makeFakeWs(1);
  await replicaB.registerMachine("machine-1", "server-1", freshWs as never);
  clock.advance(5_000);
  await flushMicrotasks(20);

  assert.equal(freshWs.sent.length, 1);
  const replay = JSON.parse(freshWs.sent[0] ?? "{}") as typeof first;
  assert.equal(replay.startDispatchId, first.startDispatchId);
  assert.equal(replay.launchId, first.launchId);
  assert.equal(
    (replicaA as any).pendingAgentStartAcks.has(first.startDispatchId),
    false,
    "previous owner must hand off rather than independently exhaust",
  );
  assert.equal((replicaB as any).pendingAgentStartAcks.has(first.startDispatchId), true);

  await replicaB.handleMachineMessage("machine-1", {
    type: "agent:start:ack",
    agentId: replay.agentId,
    launchId: replay.launchId,
    startDispatchId: replay.startDispatchId,
    queueState: "queued",
    queueDepth: 1,
    queueAgeMs: 0,
  } as MachineToServerMessage);
  clock.advance(5_000);
  await flushMicrotasks(10);
  assert.equal(freshWs.sent.length, 1);
  assert.equal((replicaB as any).pendingAgentStartAcks.has(first.startDispatchId), false);

  replicaA.shutdown();
  replicaB.shutdown();
  replicaC.shutdown();
});

test("stale self-owned replica mapping does not report the machine as online", async () => {
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  store.machineReplicaOwners.set("machine-1", REPLICA_ID);
  const orchestrator = new StartRoutingMismatchDeterministicOrchestrator(store);

  assert.equal(await orchestrator.getMachineStatus("machine-1"), "offline");
  await assert.rejects(() => orchestrator.startAgent("agent-1"), /Machine offline\. Please start your local daemon\./);

  orchestrator.shutdown();
});

test("buggy self-owned replica semantics would misclassify the machine as online", async () => {
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  store.machineReplicaOwners.set("machine-1", REPLICA_ID);
  const orchestrator = new BuggySelfOwnedReplicaReachabilityOrchestrator(store);

  assert.equal(await orchestrator.getMachineStatus("machine-1"), "online");

  orchestrator.shutdown();
});

test("loadMachineReachabilityPlanInput does not hit replica-owner lookup for missing or local machines", async () => {
  const store = new CountingReplicaOwnerStore();
  const orchestrator = new MachineReachabilityInputDeterministicOrchestrator(store);

  assert.deepEqual(await orchestrator.callLoadMachineReachabilityPlanInput(null), {
    hasMachineId: false,
    hasLocalMachine: false,
    replicaStateAvailable: true,
    ownerReplica: null,
    isExternalRuntime: false,
  });
  assert.equal(store.ownerLookupCount, 0);

  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  assert.deepEqual(await orchestrator.callLoadMachineReachabilityPlanInput({ machineId: "machine-1" }), {
    hasMachineId: true,
    hasLocalMachine: true,
    replicaStateAvailable: true,
    ownerReplica: null,
    isExternalRuntime: false,
  });
  assert.equal(store.ownerLookupCount, 0);

  orchestrator.shutdown();
});

test("loadMachineReachabilityPlanInput loads remote owner only when the machine is not local", async () => {
  const store = new CountingReplicaOwnerStore();
  store.machineReplicas.add("machine-1");
  store.machineReplicaOwners.set("machine-1", "remote-replica-2");
  const orchestrator = new MachineReachabilityInputDeterministicOrchestrator(store);

  assert.deepEqual(await orchestrator.callLoadMachineReachabilityPlanInput({ machineId: "machine-1" }), {
    hasMachineId: true,
    hasLocalMachine: false,
    replicaStateAvailable: true,
    ownerReplica: "remote-replica-2",
    isExternalRuntime: false,
  });
  assert.equal(store.ownerLookupCount, 1);

  orchestrator.shutdown();
});

test("user-visible machine read model stays offline and agent activity stays offline when reachability is gone", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator);

  const machine = await buildMachineReadModel(makeMachineRecord(), orchestrator);
  const activity = await orchestrator.getActivity("agent-1");

  assert.equal(machine.status, "offline");
  assert.deepEqual(activity, { activity: "offline", activityDetail: "" });

  orchestrator.shutdown();
});

test("user-visible machine read model stays online and agent activity stays online from shared remote reachability", async () => {
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  const orchestrator = new DeterministicAgentOrchestrator(store);
  seedActiveAgent(orchestrator);

  const machine = await buildMachineReadModel(makeMachineRecord(), orchestrator);
  const activity = await orchestrator.getActivity("agent-1");

  assert.equal(machine.status, "online");
  assert.deepEqual(activity, { activity: "online", activityDetail: "" });

  orchestrator.shutdown();
});

test("presence contract: fresh runtime profile report keeps non-owner read model present after owner lookup miss", async () => {
  const store = new InMemoryReplicaStateStore();
  const owner = new DeterministicAgentOrchestrator(store);
  const reader = new DeterministicAgentOrchestrator(store);
  seedActiveAgent(owner, "agent-1", "machine-1", "kimi");
  seedActiveAgent(reader, "agent-1", "machine-1", "kimi");
  seedMachineConnection(owner, "machine-1", makeFakeWs(1));

  assert.deepEqual(
    await reader.getActivity("agent-1"),
    { activity: "offline", activityDetail: "" },
    "owner lookup miss starts as offline before a fresh daemon report",
  );

  await owner.handleMachineMessage("machine-1", {
    type: "agent:runtime_profile",
    agentId: "agent-1",
    facts: {
      runtime: "kimi",
      model: "kimi-code",
      executionMode: "byoc",
      workspacePathRef: { label: "workspace", path: "/work/kimi", reachable: true },
      sessionRef: { label: "session-kimi", runtime: "kimi", path: "/sessions/kimi.jsonl", reachable: true },
    },
  } as MachineToServerMessage);

  assert.deepEqual(
    await reader.getActivity("agent-1"),
    { activity: "online", activityDetail: "" },
    "fresh daemon report must refresh reachability so the read model does not fake offline",
  );

  owner.shutdown();
  reader.shutdown();
});

test("presence contract: real working production projects busy across replicas after owner lookup miss", async () => {
  const store = new InMemoryReplicaStateStore();
  const owner = new DeterministicAgentOrchestrator(store);
  const reader = new DeterministicAgentOrchestrator(store);
  seedActiveAgent(owner, "agent-1", "machine-1", "codex");
  seedActiveAgent(reader, "agent-1", "machine-1", "codex");
  seedMachineConnection(owner, "machine-1", makeFakeWs(1));

  assert.deepEqual(await reader.getActivity("agent-1"), { activity: "offline", activityDetail: "" });

  await owner.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "Running tests",
    detailKind: "running_command",
    entries: [{ kind: "status", activity: "working", activityKind: "working", detail: "Running tests", detailKind: "running_command" }],
    launchId: "launch-working",
    clientSeq: 1,
  } as MachineToServerMessage);

  assert.deepEqual(
    await reader.getActivity("agent-1"),
    { activity: "working", activityDetail: "Running tests" },
    "accepted working production must project busy instead of offline/idle",
  );

  owner.shutdown();
  reader.shutdown();
});

test("getActivity suppresses weak owner-missing offline when Redis has fresh working truth", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(20_000);
  const store = new InMemoryReplicaStateStore();
  const reader = new DeterministicAgentOrchestrator(store, clock, tracer);
  seedActiveAgent(reader, "agent-1", "machine-1", "codex");
  store.agentActivities.set("agent-1", {
    activity: "working",
    detail: "Running tests",
    detailKind: "running_command",
    observedAtMs: clock.now(),
    updatedAt: clock.now(),
  });

  assert.deepEqual(
    await reader.getActivity("agent-1"),
    { activity: "working", activityDetail: "Running tests" },
    "fresh owner-written activity must beat weak owner-missing reachability",
  );
  const [suppressed] = traceEventRowsForSpanName(sink, traceId, "server.agent.activity.resolve")
    .filter((row) => row.event_name === "suppressed_weak_offline");
  assert.ok(suppressed, "weak-offline suppression must be trace-visible");
  assert.equal(suppressed.weak_source, "owner_missing");
  assert.equal(suppressed.competing_fact, "redis_busy_activity");
  assert.equal(suppressed.hint_source, "redis");
  assert.equal(suppressed.resolved_activity, "working");

  reader.shutdown();
});

test("getActivity suppresses weak owner-missing offline when persisted activity has fresh working truth", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(20_000);
  const store = new InMemoryReplicaStateStore();
  const reader = new ActivityResolutionDeterministicOrchestrator(
    store,
    {
      activity: "working",
      detail: "Editing file",
      detailKind: "other",
      updatedAt: clock.now(),
    },
    clock,
    tracer,
  );
  seedActiveAgent(reader, "agent-1", "machine-1", "codex");

  assert.deepEqual(
    await reader.getActivity("agent-1"),
    { activity: "working", activityDetail: "Editing file" },
    "fresh persisted/keyed activity must beat weak owner-missing reachability",
  );
  const [suppressed] = traceEventRowsForSpanName(sink, traceId, "server.agent.activity.resolve")
    .filter((row) => row.event_name === "suppressed_weak_offline");
  assert.ok(suppressed, "persisted weak-offline suppression must be trace-visible");
  assert.equal(suppressed.weak_source, "owner_missing");
  assert.equal(suppressed.competing_fact, "persisted_busy_activity");
  assert.equal(suppressed.hint_source, "persisted");
  assert.equal(suppressed.resolved_activity, "working");

  reader.shutdown();
});

test("getActivity lets weak owner-missing offline win after the competing activity TTL expires", async () => {
  const clock = new FakeClock();
  clock.advance(200_000);
  const store = new InMemoryReplicaStateStore();
  const reader = new DeterministicAgentOrchestrator(store, clock);
  seedActiveAgent(reader, "agent-1", "machine-1", "codex");
  store.agentActivities.set("agent-1", {
    activity: "working",
    detail: "Old run",
    detailKind: "running_command",
    updatedAt: clock.now() - 91_000,
  });

  assert.deepEqual(
    await reader.getActivity("agent-1"),
    { activity: "offline", activityDetail: "" },
    "suppression is bounded by the activity stale window",
  );

  reader.shutdown();
});

test("getActivity keeps runtime error authoritative over fresh weak-offline competing activity", async () => {
  const clock = new FakeClock();
  clock.advance(20_000);
  const store = new InMemoryReplicaStateStore();
  const reader = new DeterministicAgentOrchestrator(store, clock);
  seedActiveAgent(reader, "agent-1", "machine-1", "codex");
  seedRuntimeErrorState(reader, "agent-1", "Runtime failed");
  store.agentActivities.set("agent-1", {
    activity: "working",
    detail: "Running tests",
    detailKind: "running_command",
    updatedAt: clock.now(),
  });

  assert.deepEqual(
    await reader.getActivity("agent-1"),
    { activity: "error", activityDetail: "Runtime failed" },
    "daemon-reported runtime fatal state remains authoritative",
  );

  reader.shutdown();
});

test("presence contract: stale observed online ingress must not flatten fresh working production to idle", async () => {
  await withKernelEnvAsync(true, async () => {
    const clock = new FakeClock();
    const store = new InMemoryReplicaStateStore();
    const owner = new DeterministicAgentOrchestrator(store, clock);
    const reader = new DeterministicAgentOrchestrator(store, clock);
    seedActiveAgent(owner, "agent-1", "machine-1", "codex");
    seedActiveAgent(reader, "agent-1", "machine-1", "codex");
    seedMachineConnection(owner, "machine-1", makeFakeWs(1));

    await owner.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      activity: "working",
      detail: "Running tests",
      detailKind: "running_command",
      entries: [{ kind: "status", activity: "working", activityKind: "working", detail: "Running tests", detailKind: "running_command" }],
      launchId: "launch-working",
      clientSeq: 1,
      observedAtMs: 200,
    } as MachineToServerMessage);
    assert.deepEqual(await reader.getActivity("agent-1"), { activity: "working", activityDetail: "Running tests" });

    await owner.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      activity: "online",
      detail: "",
      detailKind: "idle",
      launchId: "launch-working",
      clientSeq: 2,
      observedAtMs: 100,
    } as MachineToServerMessage);

    assert.deepEqual(
      await reader.getActivity("agent-1"),
      { activity: "working", activityDetail: "Running tests" },
      "older accepted online/idle observation must not overwrite fresher working truth",
    );
    assert.equal(
      store.agentActivities.get("agent-1")?.activity,
      "working",
      "cross-replica mirror must keep the working projection",
    );

    owner.shutdown();
    reader.shutdown();
  });
});

test("getActivity prefers the fresher cross-replica mirror over a stale-but-recent local cache for a remote agent", async () => {
  // Activity-log delay / status inaccuracy on multi-replica (#proj-o11y A.3).
  // For an agent hosted on ANOTHER replica, this replica's in-memory activity
  // cache is only a shadow (seeded from a prior Redis read or from when the
  // agent was local here). The owning replica mirrors the agent's live activity
  // to Redis on every change. If a REST activity resolution on this replica
  // returns its <15s-old local shadow in preference to the fresher mirror, the
  // user sees stale activity until the local entry ages out — up to ~15s.
  const clock = new FakeClock();
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1"); // machine hosted on a remote replica
  const orchestrator = new DeterministicAgentOrchestrator(store, clock);
  seedActiveAgent(orchestrator);

  clock.advance(20_000);
  // Local shadow: older, but still within the 15s "fresh" window.
  (orchestrator as unknown as { agentActivity: Map<string, { activity: AgentActivityKind; detail: string; detailKind: AgentActivityDetailKind; updatedAt: number }> })
    .agentActivity.set("agent-1", { activity: "thinking", detail: "stale-local", detailKind: "other", updatedAt: 10_000 });
  // Cross-replica mirror: the owning replica's newer live activity.
  store.agentActivities.set("agent-1", { activity: "working", detail: "fresh-remote", detailKind: "other", updatedAt: 19_000 });

  const activity = await orchestrator.getActivity("agent-1");

  // Must reflect the fresher mirror, not the stale local shadow.
  assert.deepEqual(activity, { activity: "working", activityDetail: "fresh-remote" });

  orchestrator.shutdown();
});

test("getActivity does not return a timestamp-newer local shadow over the Redis mirror for a remote agent (de-shadow CC-004)", async () => {
  // Cross-replica cache-coherence contract CC-004 / INV-CC-FRESH. For a remote
  // agent the local in-memory cache is a non-authoritative shadow. Its updatedAt
  // is set by THIS replica's events and is not comparable to the owner's
  // authority — so even when the local shadow's timestamp is NEWER than the Redis
  // mirror, the owner-written mirror is the truth. The pre-de-shadow code used
  // `pickFresher(local, redis)` and returned the timestamp-newer local shadow.
  const clock = new FakeClock();
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1"); // hosted on a remote replica
  const orchestrator = new DeterministicAgentOrchestrator(store, clock);
  seedActiveAgent(orchestrator);

  clock.advance(20_000);
  // Local shadow: timestamp NEWER than the mirror, but no authority (non-owned).
  (orchestrator as unknown as { agentActivity: Map<string, { activity: AgentActivityKind; detail: string; detailKind: AgentActivityDetailKind; updatedAt: number }> })
    .agentActivity.set("agent-1", { activity: "thinking", detail: "newer-but-shadow", detailKind: "other", updatedAt: 19_000 });
  // Cross-replica mirror written by the owning replica: the authoritative value,
  // older timestamp but still fresh (<15s).
  store.agentActivities.set("agent-1", { activity: "working", detail: "owner-truth", detailKind: "other", updatedAt: 8_000 });

  try {
    const activity = await orchestrator.getActivity("agent-1");
    // Read-through Redis, not the timestamp-newer local shadow.
    assert.deepEqual(activity, { activity: "working", activityDetail: "owner-truth" });
  } finally {
    orchestrator.shutdown();
  }
});

test("getActivity does not fall back to the local shadow for a remote agent when Redis is unavailable (de-shadow CC-004a)", async () => {
  // CC-004a / INV-CC-FRESH under Redis degradation: a non-owner that cannot reach
  // Redis passes through to durable/derived state, never the process-lifetime
  // local shadow. NOTE: this is a *guard* test, not a discriminating red/green —
  // the removed Redis-down `else if (activityCached && !hostedLocally)` branch was
  // already defanged by resolveActivityHint's reachability gate (a remote agent's
  // reachability cannot be confirmed with Redis down, so the hint was ignored
  // anyway). Removing the branch is contract cleanup (no process-lifetime shadow
  // reference on the non-owner path); this test pins that the invariant holds.
  const clock = new FakeClock();
  const store = new RedisUnavailableReplicaStateStore();
  store.machineReplicas.add("machine-1"); // remote agent; Redis is down
  const orchestrator = new DeterministicAgentOrchestrator(store, clock);
  seedActiveAgent(orchestrator);

  clock.advance(20_000);
  (orchestrator as unknown as { agentActivity: Map<string, { activity: AgentActivityKind; detail: string; detailKind: AgentActivityDetailKind; updatedAt: number }> })
    .agentActivity.set("agent-1", { activity: "thinking", detail: "stale-shadow", detailKind: "other", updatedAt: 19_000 });

  try {
    const activity = await orchestrator.getActivity("agent-1");
    // With Redis down and no authoritative source, the remote agent's reachability
    // cannot be confirmed, so it derives offline — it must NOT surface the shadow.
    assert.notDeepEqual(activity, { activity: "thinking", activityDetail: "stale-shadow" });
    assert.deepEqual(activity, { activity: "offline", activityDetail: "" });
  } finally {
    orchestrator.shutdown();
  }
});

test("getActivity converges divergent replica runtime-error shadows on the Redis fingerprint and stays stable while idle (CC-004c)", async () => {
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  const replicaA = new DeterministicAgentOrchestrator(store, new FakeClock());
  const replicaB = new DeterministicAgentOrchestrator(store, new FakeClock());
  seedActiveAgent(replicaA);
  seedActiveAgent(replicaB);

  const authoritativeError: AgentRuntimeErrorState = {
    message: "Authoritative provider failure",
    at: "2026-08-02T12:00:00.000Z",
    launchId: "launch-authority",
    actionRequired: true,
  };
  const staleA: AgentRuntimeErrorState = {
    message: "stale replica A",
    at: "2026-08-02T11:00:00.000Z",
    launchId: "launch-old-a",
    actionRequired: true,
  };
  const staleB: AgentRuntimeErrorState = {
    message: "stale replica B",
    at: "2026-08-02T11:30:00.000Z",
    launchId: "launch-old-b",
    actionRequired: true,
  };
  (replicaA as any).updateCache("agent-1", { lastRuntimeError: staleA });
  (replicaB as any).updateCache("agent-1", { lastRuntimeError: staleB });
  await store.setAgentRuntimeError("agent-1", authoritativeError);

  try {
    const expected = { activity: "error" as const, activityDetail: authoritativeError.message };
    for (let read = 0; read < 5; read += 1) {
      assert.deepEqual(await Promise.all([
        replicaA.getActivity("agent-1"),
        replicaB.getActivity("agent-1"),
      ]), [expected, expected]);
    }
    assert.deepEqual((replicaA as any).agentStateCache.get("agent-1")?.lastRuntimeError, authoritativeError);
    assert.deepEqual((replicaB as any).agentStateCache.get("agent-1")?.lastRuntimeError, authoritativeError);
    assert.equal(
      store.agentRuntimeErrors.get("agent-1")?.fingerprint,
      fingerprintAgentRuntimeError(authoritativeError),
    );
  } finally {
    replicaA.shutdown();
    replicaB.shutdown();
  }
});

test("runtime-error mirror synchronizes awaited writes and explicit clears across replicas (CC-004c)", async () => {
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  const owner = new DeterministicAgentOrchestrator(store, new FakeClock());
  const reader = new DeterministicAgentOrchestrator(store, new FakeClock());
  seedActiveAgent(owner);
  seedActiveAgent(reader);
  const error: AgentRuntimeErrorState = {
    message: "Runtime failed",
    at: "2026-08-02T12:00:00.000Z",
    launchId: "launch-error",
    actionRequired: true,
  };

  try {
    await (owner as any).rememberRuntimeError("agent-1", error);
    assert.deepEqual(store.agentRuntimeErrors.get("agent-1")?.error, error);
    assert.deepEqual(await reader.getActivity("agent-1"), {
      activity: "error",
      activityDetail: error.message,
    });

    await (owner as any).clearLastRuntimeError("agent-1");
    assert.equal(store.agentRuntimeErrors.get("agent-1")?.error, null);
    assert.equal(
      store.agentRuntimeErrors.get("agent-1")?.fingerprint,
      fingerprintAgentRuntimeError(null),
    );
    assert.notEqual((reader as any).agentStateCache.get("agent-1")?.lastRuntimeError, null);
    assert.deepEqual(await reader.getActivity("agent-1"), {
      activity: "online",
      activityDetail: "",
    });
    assert.equal((reader as any).agentStateCache.get("agent-1")?.lastRuntimeError, null);
  } finally {
    owner.shutdown();
    reader.shutdown();
  }
});

test("runtime-error set and clear do not resolve before their Redis authority writes settle (CC-004c write fence)", async () => {
  class DeferredRuntimeErrorReplicaStateStore extends InMemoryReplicaStateStore {
    readonly writes = [
      { entered: deferred<void>(), release: deferred<void>() },
      { entered: deferred<void>(), release: deferred<void>() },
    ];
    private writeIndex = 0;

    override async setAgentRuntimeError(agentId: string, error: AgentRuntimeErrorState | null): Promise<void> {
      const write = this.writes[this.writeIndex++];
      assert.ok(write, "unexpected runtime-error mirror write");
      write.entered.resolve();
      await write.release.promise;
      await super.setAgentRuntimeError(agentId, error);
    }
  }

  const store = new DeferredRuntimeErrorReplicaStateStore();
  const orchestrator = new DeterministicAgentOrchestrator(store, new FakeClock());
  seedActiveAgent(orchestrator);
  const error: AgentRuntimeErrorState = {
    message: "Runtime failed",
    at: "2026-08-02T12:00:00.000Z",
    launchId: "launch-error",
    actionRequired: true,
  };

  try {
    let setSettled = false;
    const setPending = (orchestrator as any).rememberRuntimeError("agent-1", error)
      .finally(() => { setSettled = true; });
    await store.writes[0].entered.promise;
    await flushMicrotasks();
    assert.equal(setSettled, false);
    store.writes[0].release.resolve();
    await setPending;
    assert.equal(setSettled, true);

    let clearSettled = false;
    const clearPending = (orchestrator as any).clearLastRuntimeError("agent-1")
      .finally(() => { clearSettled = true; });
    await store.writes[1].entered.promise;
    await flushMicrotasks();
    assert.equal(clearSettled, false);
    store.writes[1].release.resolve();
    await clearPending;
    assert.equal(clearSettled, true);
  } finally {
    orchestrator.shutdown();
  }
});

test("runtime-error Redis authority is not published when durable set returns false or throws (CC-004c durable acceptance)", async () => {
  class RejectedRuntimeErrorPersistenceOrchestrator extends DeterministicAgentOrchestrator {
    constructor(
      store: ReplicaStateStore,
      private readonly rejection: "false" | "throw",
    ) {
      super(store, new FakeClock());
    }

    protected override async persistAgentLastRuntimeError(): Promise<boolean> {
      if (this.rejection === "throw") throw new Error("durable set failed");
      return false;
    }
  }

  for (const rejection of ["false", "throw"] as const) {
    const store = new InMemoryReplicaStateStore();
    store.machineReplicas.add("machine-1");
    const owner = new RejectedRuntimeErrorPersistenceOrchestrator(store, rejection);
    const reader = new DeterministicAgentOrchestrator(store, new FakeClock());
    seedActiveAgent(owner);
    seedActiveAgent(reader);
    const error: AgentRuntimeErrorState = {
      message: `Runtime failed (${rejection})`,
      at: "2026-08-02T12:00:00.000Z",
      launchId: `launch-set-${rejection}`,
      actionRequired: true,
    };

    try {
      if (rejection === "throw") {
        await assert.rejects(
          (owner as any).rememberRuntimeError("agent-1", error),
          /durable set failed/,
        );
      } else {
        assert.equal(await (owner as any).rememberRuntimeError("agent-1", error), false);
      }

      assert.equal(store.agentRuntimeErrors.has("agent-1"), false);
      assert.equal((owner as any).agentStateCache.get("agent-1")?.lastRuntimeError, null);
      assert.deepEqual(await reader.getActivity("agent-1"), {
        activity: "online",
        activityDetail: "",
      });
      assert.equal(store.agentRuntimeErrors.get("agent-1")?.error, null);
    } finally {
      owner.shutdown();
      reader.shutdown();
    }
  }
});

test("runtime-error Redis authority is not cleared when durable clear returns false or throws (CC-004c durable acceptance)", async () => {
  class RejectedRuntimeErrorClearOrchestrator extends DeterministicAgentOrchestrator {
    constructor(
      store: ReplicaStateStore,
      private readonly rejection: "false" | "throw",
    ) {
      super(store, new FakeClock());
    }

    protected override async clearPersistedAgentLastRuntimeError(): Promise<boolean> {
      if (this.rejection === "throw") throw new Error("durable clear failed");
      return false;
    }
  }

  for (const rejection of ["false", "throw"] as const) {
    const store = new InMemoryReplicaStateStore();
    store.machineReplicas.add("machine-1");
    const owner = new RejectedRuntimeErrorClearOrchestrator(store, rejection);
    const reader = new DeterministicAgentOrchestrator(store, new FakeClock());
    seedActiveAgent(owner);
    seedActiveAgent(reader);
    const error: AgentRuntimeErrorState = {
      message: `Runtime failed before clear (${rejection})`,
      at: "2026-08-02T12:00:00.000Z",
      launchId: `launch-clear-${rejection}`,
      actionRequired: true,
    };

    try {
      await (owner as any).rememberRuntimeError("agent-1", error);
      assert.deepEqual(store.agentRuntimeErrors.get("agent-1")?.error, error);

      if (rejection === "throw") {
        await assert.rejects(
          (owner as any).clearLastRuntimeError("agent-1"),
          /durable clear failed/,
        );
      } else {
        assert.equal(await (owner as any).clearLastRuntimeError("agent-1"), false);
      }

      assert.deepEqual(store.agentRuntimeErrors.get("agent-1")?.error, error);
      assert.deepEqual((owner as any).agentStateCache.get("agent-1")?.lastRuntimeError, error);
      assert.deepEqual(await reader.getActivity("agent-1"), {
        activity: "error",
        activityDetail: error.message,
      });
    } finally {
      owner.shutdown();
      reader.shutdown();
    }
  }
});

test("getActivity re-sources persistence instead of resurrecting a local runtime-error shadow when Redis is unavailable (CC-004c degraded)", async () => {
  class ClearedPersistedRuntimeErrorOrchestrator extends DeterministicAgentOrchestrator {
    protected override async loadAgentForDelivery(agentId: string): Promise<any> {
      const agent = await super.loadAgentForDelivery(agentId);
      return agent ? { ...agent, lastRuntimeError: null } : null;
    }
  }

  const store = new RedisUnavailableReplicaStateStore();
  store.machineReplicas.add("machine-1");
  const orchestrator = new ClearedPersistedRuntimeErrorOrchestrator(store, new FakeClock());
  seedActiveAgent(orchestrator);
  (orchestrator as any).updateCache("agent-1", {
    lastRuntimeError: {
      message: "stale process-local error",
      at: "2026-08-02T11:00:00.000Z",
      launchId: "launch-stale",
      actionRequired: true,
    },
  });

  try {
    assert.deepEqual(await orchestrator.getActivity("agent-1"), {
      activity: "offline",
      activityDetail: "",
    });
    assert.equal((orchestrator as any).agentStateCache.get("agent-1")?.lastRuntimeError, null);
  } finally {
    orchestrator.shutdown();
  }
});

// --- INV-CC-OWNER: cross-replica activity emit is owner-only / single-delivery ---
//
// Directly tests the hypothesis raised in #wg-frontend-perf / #proj-o11y that
// #2601 (cross-replica activity mirror) makes the SAME `agent:activity` event get
// pushed N times (once per replica) to a client => `agent:activity` socket flood
// => global frontend lag. Cross-replica client delivery is done by the Socket.IO
// Redis adapter, which forwards each `io.to(room).emit()` to remote clients exactly
// once. So the number of client-bound frames for one daemon event ==
// the number of distinct `emitActivity` calls across the whole replica network.
//
// CC-001 (single-writer) + CC-006 (owner-only emit, no broadcast amplification):
// only the OWNER replica (the one the daemon's single WS lands on) emits; non-owner
// replicas serve client reads PULL-only (getActivity reads the mirror, never emits).
// #2601 changed only the getActivity READ path; it adds no socket emit.
class ActivityEmitCapturingOrchestrator extends DeterministicAgentOrchestrator {
  readonly emittedActivityPayloads: Array<Record<string, unknown>> = [];
  constructor(
    store: ReplicaStateStore,
    clock?: TestClock,
  ) {
    super(store, clock);
    (this as any).io = {
      to: () => ({
        emit: (event: string, payload: unknown) => {
          if (event === "agent:activity") this.emittedActivityPayloads.push(payload as Record<string, unknown>);
        },
      }),
    };
  }

  // Durable activity-log persistence is exercised elsewhere; here we only care about
  // the socket emit fanout, so no-op the DB write (avoids "Database not initialized").
  protected override async persistActivityEvent(): Promise<boolean> {
    return true;
  }
}

// RED fixture: a non-owner replica that ALSO re-pushes the mirror value to its own
// clients on every getActivity read (the hypothesized #2601 / CC-006 violation).
class MirrorReadAlsoPushesOrchestrator extends ActivityEmitCapturingOrchestrator {
  override async getActivity(agentId: string) {
    const result = await super.getActivity(agentId);
    (this as any).io.to("server:server-1").emit("agent:activity", {
      agentId,
      activity: result.activity,
      detail: result.activityDetail,
      mirroredPush: true,
    });
    return result;
  }
}

async function runCrossReplicaActivityFanout(
  NonOwnerCls: new (store: ReplicaStateStore) => ActivityEmitCapturingOrchestrator,
) {
  const shared = new InMemoryReplicaStateStore();
  // Owner replica A: the daemon's single WS connects here, so it hosts machine-1
  // locally and is the sole emitter of this agent's activity.
  const owner = new ActivityEmitCapturingOrchestrator(shared);
  seedActiveAgent(owner);
  seedMachineConnection(owner, "machine-1", makeFakeWs());
  // Non-owner replica B: same agent visible, but machine-1 is owned by A (remote).
  // B only serves client REST activity reads (the #2601 mirror read path).
  const nonOwner = new NonOwnerCls(shared);
  seedActiveAgent(nonOwner);
  shared.machineReplicas.add("machine-1"); // reachable on a remote replica from B's view

  // One daemon activity event lands on the owner (a single agent "counting" tick).
  await owner.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "counting: 1",
    launchId: "launch-1",
    clientSeq: 1,
    entries: [{ kind: "status", activity: "working", detail: "counting: 1" }],
  } as MachineToServerMessage);

  // Several clients hit replica B for the agent's activity (REST reads served by a
  // non-owner replica). In prod this is the unread/agent-list resolution path.
  const CLIENT_READS = 5;
  for (let i = 0; i < CLIENT_READS; i++) await nonOwner.getActivity("agent-1");

  const ownerEmits = owner.emittedActivityPayloads.length;
  const nonOwnerEmits = nonOwner.emittedActivityPayloads.length;
  owner.shutdown();
  nonOwner.shutdown();
  return { ownerEmits, nonOwnerEmits, total: ownerEmits + nonOwnerEmits };
}

test("INV-CC-OWNER: one daemon activity event yields exactly ONE client-bound agent:activity frame across replicas (no #2601 cross-replica duplication)", async () => {
  const r = await runCrossReplicaActivityFanout(ActivityEmitCapturingOrchestrator);
  // Owner emits exactly once; serverSeq is the single monotonic outbound id.
  assert.equal(r.ownerEmits, 1);
  // Non-owner serves 5 client reads and pushes NOTHING — reads are pull-only.
  assert.equal(r.nonOwnerEmits, 0);
  // Therefore the client receives exactly 1 frame per event, independent of replica
  // count: the adapter delivers a single owner emit once per client. No N-times push.
  assert.equal(r.total, 1);
});

test("INV-CC-OWNER red fixture: a non-owner replica re-pushing the mirror on read is caught by the same metric (total > 1)", async () => {
  const r = await runCrossReplicaActivityFanout(MirrorReadAlsoPushesOrchestrator);
  // The injected CC-006 violation pushes on every read => the same total-frames
  // metric the GREEN test pins at 1 now blows past 1, proving the gate has teeth
  // and would catch a real cross-replica duplicate-push regression.
  assert.ok(r.nonOwnerEmits > 0, `expected non-owner pushes, got ${r.nonOwnerEmits}`);
  assert.ok(r.total > 1, `expected duplicate frames > 1, got ${r.total}`);
});

test("user-visible machine read model includes the current local daemon version", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  const ws = makeFakeWs();
  const conn = seedMachineConnection(orchestrator, "machine-1", ws);
  (conn as { daemonVersion: string | null }).daemonVersion = "1.2.3";

  const machine = await buildMachineReadModel(makeMachineRecord(), orchestrator);

  assert.equal(machine.status, "online");
  assert.equal(machine.daemonVersion, "1.2.3");

  orchestrator.shutdown();
});

test("user-visible machine read model treats stale open local sockets as offline", async () => {
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), clock);
  const ws = makeFakeWs(1);
  await orchestrator.registerMachine("machine-1", "server-1", ws as never);

  // At 60s the cleanup heartbeat has not terminated yet because the timeout is
  // strictly greater than 60s. The read model must still stop treating this
  // half-dead local connection as online.
  clock.advance(60_001);

  const machine = await buildMachineReadModel(makeMachineRecord(), orchestrator);

  assert.equal(ws.readyState, 1);
  assert.equal(machine.status, "offline");

  orchestrator.shutdown();
});

test("user-visible machine read model falls back to the persisted daemon version for remotely reachable machines", async () => {
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  const orchestrator = new DeterministicAgentOrchestrator(store);

  const machine = await buildMachineReadModel({
    ...makeMachineRecord(),
    daemonVersion: "1.2.3",
  }, orchestrator);

  assert.equal(machine.status, "online");
  assert.equal(machine.daemonVersion, "1.2.3");

  orchestrator.shutdown();
});

test("machine status websocket event matches machine read model when a machine connects", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  orchestrator.setIO(makeFakeServerIO(emitted) as never);
  const ws = makeFakeWs(1);

  await orchestrator.registerMachine("machine-1", "server-1", ws as never);

  const machine = await buildMachineReadModel(makeMachineRecord(), orchestrator);
  assert.deepEqual(emitted.at(-1), {
    room: "server:server-1",
    event: "machine:status",
    payload: { machineId: "machine-1", status: "online", statusVersion: 1 },
  });
  assert.equal(machine.status, "online");
  assert.equal(machine.statusVersion, 1);
  assert.equal(machine.status, (emitted.at(-1)?.payload as { status: string }).status);

  orchestrator.shutdown();
});

test("machine status websocket event matches machine read model when a machine disconnects", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(undefined, clock, tracer);
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  orchestrator.setIO(makeFakeServerIO(emitted) as never);
  const ws = makeFakeWs(1);
  await orchestrator.registerMachine("machine-1", "server-1", ws as never);

  await orchestrator.handleMachineDisconnect("machine-1", ws as never, { cause: "socket_close" });

  assert.equal((emitted.at(-1)?.payload as { status: string }).status, "online");
  assert.equal((await buildMachineReadModel(makeMachineRecord(), orchestrator)).status, "online");
  await advanceClockAndWaitForCondition(clock, 2000, () => emitted.length > 1);

  const machine = await buildMachineReadModel(makeMachineRecord(), orchestrator);
  assert.deepEqual(emitted.at(-1), {
    room: "server:server-1",
    event: "machine:status",
    payload: { machineId: "machine-1", status: "offline", statusVersion: 2, cause: "socket_close" },
  });
  assert.equal(machine.status, "offline");
  assert.equal(machine.statusVersion, 2);
  assert.equal(machine.status, (emitted.at(-1)?.payload as { status: string }).status);
  const [registerStatusRow] = traceEventRowsForSpanName(sink, traceId, "server.machine.connection.register")
    .filter((row) => row.event_name === "machine.status.emitted");
  assert.ok(registerStatusRow);
  assert.equal(registerStatusRow.machine_id, "machine-1");
  assert.equal(registerStatusRow.server_id, "server-1");
  assert.equal(registerStatusRow.outcome, "emitted");
  const disconnectSpan = sink.getTrace(traceId).find((span) => span.name === "server.machine.connection.disconnect");
  assert.ok(disconnectSpan);
  assert.equal(disconnectSpan.attrs?.machine_id, "machine-1");
  assert.equal(disconnectSpan.attrs?.server_id, "server-1");
  assert.equal(disconnectSpan.attrs?.machine_id_present, true);
  assert.equal(disconnectSpan.attrs?.cause, "socket_close");
  assert.equal(disconnectSpan.attrs?.outcome, "scheduled");
  const disconnectFact = traceSpanFactRowForSpanName(sink, traceId, "server.machine.connection.disconnect");
  assert.equal(disconnectFact.row_kind, "span_fact");
  assert.equal(disconnectFact.event_name, "server.machine.connection.disconnect");
  assert.equal(disconnectFact.event_index, null);
  assert.equal(disconnectFact.machine_id, "machine-1");
  assert.equal(disconnectFact.server_id, "server-1");
  assert.equal(disconnectFact.outcome, "scheduled");
  const projectionSpan = sink.getTrace(traceId).find((span) => span.name === "server.machine.connection.disconnect_projection");
  assert.ok(projectionSpan);
  assert.equal(projectionSpan.attrs?.machine_id, "machine-1");
  assert.equal(projectionSpan.attrs?.server_id, "server-1");
  assert.equal(projectionSpan.attrs?.machine_id_present, true);
  assert.equal(projectionSpan.attrs?.cause, "socket_close");
  assert.equal(projectionSpan.attrs?.outcome, "processed");
  assert.equal(projectionSpan.attrs?.affected_agents_count, 0);
  assert.equal(projectionSpan.attrs?.status_version, 2);
  const [offlineStatusRow] = traceEventRowsForSpanName(sink, traceId, "server.machine.connection.disconnect_projection")
    .filter((row) => row.event_name === "machine.status.emitted");
  assert.ok(offlineStatusRow);
  assert.equal(offlineStatusRow.machine_id, "machine-1");
  assert.equal(offlineStatusRow.server_id, "server-1");
  assert.equal(offlineStatusRow.outcome, "emitted");

  orchestrator.shutdown();
});

test("a never-settling lifecycle observation cannot block disconnect grace or offline projection", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  const orchestrator = new HangingLifecycleObservationOrchestrator(undefined, clock, tracer);
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  orchestrator.setIO(makeFakeServerIO(emitted) as never);
  const ws = makeFakeWs(1);
  await orchestrator.registerMachine("machine-1", "server-1", ws as never);

  await orchestrator.handleMachineDisconnect("machine-1", ws as never, { cause: "socket_close" });
  assert.equal((orchestrator as any).pendingMachineDisconnects.has("machine-1"), true);

  await advanceClockAndWaitForCondition(clock, 2000, () => emitted.length > 1);
  assert.equal((emitted.at(-1)?.payload as { status: string }).status, "offline");
  const sidecarSpan = sink.getTrace(traceId).find((span) =>
    span.name === "server.computer.operation.disconnect_observation"
  );
  assert.ok(sidecarSpan);
  assert.equal(sidecarSpan.attrs?.outcome, "timeout");
  assert.equal(sidecarSpan.attrs?.error_class, "timeout");

  orchestrator.shutdown();
});

test("lifecycle observation rejection does not expose an attacker-controlled error name", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  const attackerName = `AttackerControlled${"x".repeat(10_000)}`;
  const observationError = new Error("sensitive database detail");
  observationError.name = attackerName;
  const orchestrator = new RejectingLifecycleObservationOrchestrator(observationError, clock, tracer);
  const ws = makeFakeWs(1);
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;

  await orchestrator.registerMachine("machine-1", "server-1", ws as never);
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    await orchestrator.handleMachineDisconnect("machine-1", ws as never, { cause: "socket_close" });
    await flushMicrotasks();
  } finally {
    console.warn = originalWarn;
    orchestrator.shutdown();
  }

  const sidecarSpan = sink.getTrace(traceId).find((span) =>
    span.name === "server.computer.operation.disconnect_observation"
  );
  assert.ok(sidecarSpan);
  assert.equal(sidecarSpan.attrs?.outcome, "error");
  assert.equal(sidecarSpan.attrs?.error_class, "Error");
  assert.equal(warnings.length, 1);
  assert.equal(String(warnings[0]?.[0]).endsWith("(Error)"), true);
  assert.equal(JSON.stringify({ sidecarSpan, warnings }).includes(attackerName), false);
  assert.equal(JSON.stringify({ sidecarSpan, warnings }).includes(observationError.message), false);
});

test("machine disconnect within grace then reconnect does not emit user-visible offline", async () => {
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(undefined, clock);
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  orchestrator.setIO(makeFakeServerIO(emitted) as never);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  const ws1 = makeFakeWs(1);
  await orchestrator.registerMachine("machine-1", "server-1", ws1 as never);
  emitted.length = 0;

  await orchestrator.handleMachineDisconnect("machine-1", ws1 as never, { cause: "socket_close" });
  clock.advance(1999);
  await orchestrator.registerMachine("machine-1", "server-1", makeFakeWs(1) as never);
  clock.advance(2000);
  await flushMicrotasks();

  assert.equal(await orchestrator.getMachineStatus("machine-1"), "online");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });
  assert.deepEqual(emitted.map((entry) => entry.payload), [
    { machineId: "machine-1", status: "online", statusVersion: 2 },
  ]);

  orchestrator.shutdown();
});

test("true machine disconnect beyond grace emits user-visible offline with cause", async () => {
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(undefined, clock);
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  orchestrator.setIO(makeFakeServerIO(emitted) as never);
  const ws = makeFakeWs(1);
  await orchestrator.registerMachine("machine-1", "server-1", ws as never);
  emitted.length = 0;

  await orchestrator.handleMachineDisconnect("machine-1", ws as never, { cause: "heartbeat_timeout" });
  clock.advance(1999);
  await flushMicrotasks();
  assert.equal(emitted.length, 0);
  assert.equal(await orchestrator.getMachineStatus("machine-1"), "online");
  await advanceClockAndWaitForCondition(clock, 1, () => emitted.length > 0);

  assert.deepEqual(emitted.at(-1), {
    room: "server:server-1",
    event: "machine:status",
    payload: { machineId: "machine-1", status: "offline", statusVersion: 2, cause: "heartbeat_timeout" },
  });
  assert.equal(await orchestrator.getMachineStatus("machine-1"), "offline");

  orchestrator.shutdown();
});
test("machine status version increases monotonically across reconnect handoffs", async () => {
  const shared = new ControlledReplicaState();
  const clock = new FakeClock();
  const replicaA = new DeterministicAgentOrchestrator(new ControlledReplicaStateStore(shared, "replica-a"), clock);
  const replicaB = new DeterministicAgentOrchestrator(new ControlledReplicaStateStore(shared, "replica-b"));

  const ws = makeFakeWs();
  await replicaA.registerMachine("machine-1", "server-1", ws as never);
  const online = await buildMachineReadModel(makeMachineRecord(), replicaB);
  assert.equal(online.status, "online");
  assert.equal(online.statusVersion, 1);

  await replicaA.handleMachineDisconnect("machine-1", ws as never, { cause: "socket_close" });
  await advanceClockAndWaitForCondition(clock, 2000, () => shared.machineStatusVersions.get("machine-1") === 2);
  const offline = await buildMachineReadModel(makeMachineRecord(), replicaB);
  assert.equal(offline.status, "offline");
  assert.equal(offline.statusVersion, 2);

  await replicaA.registerMachine("machine-1", "server-1", makeFakeWs() as never);
  const reconnected = await buildMachineReadModel(makeMachineRecord(), replicaB);
  assert.equal(reconnected.status, "online");
  assert.equal(reconnected.statusVersion, 3);

  replicaA.shutdown();
  replicaB.shutdown();
});

test("machine reconnect during delayed disconnect unregister keeps replica ownership online", async () => {
  const shared = new ControlledReplicaState();
  const clock = new FakeClock();
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const replicaA = new DeterministicAgentOrchestrator(new ControlledReplicaStateStore(shared, "replica-a"), clock, tracer);
  const replicaB = new DeterministicAgentOrchestrator(new ControlledReplicaStateStore(shared, "replica-b"));
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  replicaA.setIO(makeFakeServerIO(emitted) as never);
  const ws1 = makeFakeWs();
  await replicaA.registerMachine("machine-1", "server-1", ws1 as never);
  emitted.length = 0;
  const unregisterGate = shared.deferNextMachineMutation({
    type: "unregister",
    machineId: "machine-1",
    replicaId: "replica-a",
  });

  await replicaA.handleMachineDisconnect("machine-1", ws1 as never, { cause: "socket_close" });
  clock.advance(2000);
  await flushMicrotasks(10);
  assert.equal(shared.machineOwners.get("machine-1"), "replica-a");
  assert.equal(await replicaB.getMachineStatus("machine-1"), "online");

  await replicaA.registerMachine("machine-1", "server-1", makeFakeWs() as never);
  unregisterGate.resolve();
  await waitForCondition(
    () => sink.getTrace(traceId).some((span) =>
      span.name === "server.machine.connection.disconnect_projection"
      && span.attrs?.outcome === "canceled_after_reconnect",
    ),
    100,
  );
  assert.equal(shared.machineOwners.get("machine-1"), "replica-a");
  assert.equal(await replicaB.getMachineStatus("machine-1"), "online");
  assert.deepEqual(emitted.map((entry) => entry.payload), [
    { machineId: "machine-1", status: "online", statusVersion: 2 },
  ]);

  replicaA.shutdown();
  replicaB.shutdown();
});

test("machine disconnect commits replica unregister before emitting offline status", async () => {
  const shared = new ControlledReplicaState();
  const clock = new FakeClock();
  const replicaA = new DeterministicAgentOrchestrator(new ControlledReplicaStateStore(shared, "replica-a"), clock);
  const replicaB = new DeterministicAgentOrchestrator(new ControlledReplicaStateStore(shared, "replica-b"));
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  replicaA.setIO(makeFakeServerIO(emitted) as never);

  const ws = makeFakeWs();
  await replicaA.registerMachine("machine-1", "server-1", ws as never);
  await flushMicrotasks();
  assert.equal(await replicaB.getMachineStatus("machine-1"), "online");
  emitted.length = 0;

  const unregisterGate = shared.deferNextMachineMutation({
    type: "unregister",
    machineId: "machine-1",
    replicaId: "replica-a",
  });
  const disconnect = replicaA.handleMachineDisconnect("machine-1", ws as never, { cause: "socket_close" });
  await flushMicrotasks(10);
  await disconnect;
  clock.advance(2000);
  await flushMicrotasks(10);

  assert.equal(await replicaB.getMachineStatus("machine-1"), "online",
    "while unregister is still pending, a non-owner REST read would still see the old owner key");
  assert.equal(emitted.length, 0,
    "offline must not be emitted before cross-replica reads can observe offline");

  unregisterGate.resolve();
  await waitForCondition(() => emitted.length > 0);

  assert.deepEqual(emitted.at(-1), {
    room: "server:server-1",
    event: "machine:status",
    payload: { machineId: "machine-1", status: "offline", statusVersion: 2, cause: "socket_close" },
  });
  assert.equal(await replicaB.getMachineStatus("machine-1"), "offline");

  replicaA.shutdown();
  replicaB.shutdown();
});

test("machine disconnect emits offline even when replica unregister fails", async () => {
  const store = new RejectingUnregisterReplicaStateStore();
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(store, clock);
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  orchestrator.setIO(makeFakeServerIO(emitted) as never);
  const ws = makeFakeWs();
  await orchestrator.registerMachine("machine-1", "server-1", ws as never);
  emitted.length = 0;

  await assert.doesNotReject(() => orchestrator.handleMachineDisconnect("machine-1", ws as never, { cause: "socket_close" }));
  await advanceClockAndWaitForCondition(clock, 2000, () => emitted.length > 0);

  assert.deepEqual(emitted.at(-1), {
    room: "server:server-1",
    event: "machine:status",
    payload: { machineId: "machine-1", status: "offline", statusVersion: 2, cause: "socket_close" },
  });

  orchestrator.shutdown();
});

test("machine disconnect emits offline when replica unregister hangs past the guard timeout", async () => {
  const store = new HangingUnregisterReplicaStateStore();
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(store, clock);
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  orchestrator.setIO(makeFakeServerIO(emitted) as never);
  const ws = makeFakeWs();
  await orchestrator.registerMachine("machine-1", "server-1", ws as never);
  emitted.length = 0;

  await assert.doesNotReject(() => orchestrator.handleMachineDisconnect("machine-1", ws as never, { cause: "socket_close" }));
  clock.advance(2000);
  await flushMicrotasks();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await waitForCondition(() => emitted.length > 0);

  assert.deepEqual(emitted.at(-1), {
    room: "server:server-1",
    event: "machine:status",
    payload: { machineId: "machine-1", status: "offline", statusVersion: 2, cause: "socket_close" },
  });

  orchestrator.shutdown();
});

test("trajectory activity events are durably persisted and hydration matches the emitted websocket payload", async () => {
  const clock = new FakeClock();
  clock.advance(1234);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const entries: TrajectoryEntry[] = [
    { kind: "thinking", text: "plan" },
    { kind: "tool_start", toolName: "read_file", toolInput: "{\"path\":\"foo.ts\"}" },
  ];

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "editing",
    entries,
  } as MachineToServerMessage);

  assert.equal(orchestrator.emittedActivityPayloads.length, 1);
  assert.deepEqual(orchestrator.emittedActivityPayloads[0], {
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "editing",
    detailKind: "other",
    timestamp: clock.now(),
    serverSeq: 1,
  });
  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), entries.map((entry) => ({
    timestamp: clock.now(),
    entry,
  })));

  orchestrator.shutdown();
});

test("accepted agent:activity ingest threads launchId/clientSeq/probeId/producerFactId all the way to the emitted Socket.IO payload (task #136)", async () => {
  // Stone's BLOCKER review on PR #3257: previous tests only exercised the
  // reducer seam and the applyActivityBroadcastAction seam. This test
  // proves the join keys survive the ACCEPTED ingest path
  // (`handleMachineMessage` -> `reduceDaemonActivityLifecycle` ->
  // `applyAgentLifecycleProjectionPlan` -> `broadcastActivity` ->
  // `emitActivity`). The earlier accepted-path call site silently
  // dropped the keys before the reducer; this regression pins the fix.
  const clock = new FakeClock();
  clock.advance(2_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const entries: TrajectoryEntry[] = [{ kind: "thinking", text: "plan" }];

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "editing",
    entries,
    launchId: "L-77",
    clientSeq: 123,
    probeId: "P-xyz",
    producerFactId: "daemon_activity:agent-1:L-77:123",
  } as MachineToServerMessage);

  assert.equal(orchestrator.emittedActivityPayloads.length, 1);
  assert.deepEqual(orchestrator.emittedActivityPayloads[0], {
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "editing",
    detailKind: "other",
    timestamp: clock.now(),
    serverSeq: 1,
    launchId: "L-77",
    clientSeq: 123,
    probeId: "P-xyz",
    producerFactId: "daemon_activity:agent-1:L-77:123",
  });

  orchestrator.shutdown();
});

test("accepted agent:activity ingest falls back from legacy activity when kind fields are absent (older daemons; task #136, task #442)", async () => {
  const clock = new FakeClock();
  clock.advance(2_500);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const entries: TrajectoryEntry[] = [{ kind: "thinking", text: "plan" }];

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "editing",
    entries,
    // No activityKind / detailKind / launchId / clientSeq / probeId —
    // emulates an older daemon's inbound message. The Socket.IO payload
    // must still normalize from legacy activity/detail while omitting
    // absent join keys entirely (no `legacy` synthesis, no `null`
    // placeholder); feedback-export classifies the row as
    // `join_key_missing`.
  } as MachineToServerMessage);

  assert.equal(orchestrator.emittedActivityPayloads.length, 1);
  const emitted = orchestrator.emittedActivityPayloads[0] as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(emitted, "launchId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(emitted, "clientSeq"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(emitted, "probeId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(emitted, "producerFactId"), false);
  assert.equal(emitted.activity, "working");
  assert.equal(emitted.activityKind, "working");
  assert.equal(emitted.detail, "editing");
  assert.equal(emitted.detailKind, "other");
  assert.equal(emitted.serverSeq, 1);

  orchestrator.shutdown();
});

test("external plugin activity maps into managed activity trajectory with provenance and truncation", () => {
  const toolStart = mapExternalPluginActivityEvent({
    eventId: "external-event-1",
    hookEventName: "PreToolUse",
    toolName: "Bash",
    toolInput: "npm test",
    occurredAt: "2026-06-12T01:02:03.000Z",
  });
  assert.deepEqual(toolStart, {
    activity: "working",
    detail: "Running command…",
    entries: [{
      kind: "tool_start",
      toolName: "Bash",
      toolInput: "npm test",
      producerFactId: `${EXTERNAL_AGENT_ACTIVITY_PROVENANCE}:external-event-1`,
    }],
    occurredAtMs: Date.parse("2026-06-12T01:02:03.000Z"),
    dedupeKey: "external-agent-activity:external-event-1",
  });

  const toolOutput = mapExternalPluginActivityEvent({
    eventId: "external-event-2",
    hookEventName: "PostToolUse",
    toolName: "Bash",
    toolOutput: "x".repeat(4500),
    occurredAt: "2026-06-12T01:02:04.000Z",
  });
  assert.equal(toolOutput?.entries[0]?.kind, "system");
  const entry = toolOutput?.entries[0];
  if (entry?.kind === "system") {
    assert.equal(entry.title, "Tool output: Bash");
    assert.match(entry.text, /\[truncated\]$/);
    assert.ok(entry.text.length <= 4096);
    assert.equal(entry.producerFactId, `${EXTERNAL_AGENT_ACTIVITY_PROVENANCE}:external-event-2`);
  }

  const plugin030Output = mapExternalPluginActivityEvent({
    event_id: "external-event-3",
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_output: "x".repeat(4090),
    truncated: true,
  });
  const plugin030Entry = plugin030Output?.entries[0];
  assert.equal(plugin030Entry?.kind, "system");
  if (plugin030Entry?.kind === "system") {
    assert.match(plugin030Entry.text, /\[truncated\]$/);
    assert.ok(plugin030Entry.text.length <= 4096);
  }

  const bridgeFatal = mapExternalPluginActivityEvent({
    eventId: "bridge-fatal-1",
    hookEventName: "BridgeFatal",
    errorClass: "BRIDGE_WAKE_HINTS_FAILED",
    toolOutput: "credential revoked",
    occurredAt: "2026-06-12T01:02:05.000Z",
  });
  assert.equal(bridgeFatal?.activity, "error");
  assert.equal(bridgeFatal?.detail, "Bridge fatal: BRIDGE_WAKE_HINTS_FAILED");
  assert.equal(bridgeFatal?.entries[0]?.kind, "status");
  assert.equal(bridgeFatal?.entries[1]?.kind, "system");
  const bridgeFatalStatus = bridgeFatal?.entries[0];
  if (bridgeFatalStatus?.kind === "status") {
    assert.equal(bridgeFatalStatus.activity, "error");
    assert.equal(bridgeFatalStatus.detailKind, "external_activity");
    assert.equal(bridgeFatalStatus.producerFactId, `${EXTERNAL_AGENT_ACTIVITY_PROVENANCE}:bridge-fatal-1`);
  }
  const bridgeFatalSystem = bridgeFatal?.entries[1];
  if (bridgeFatalSystem?.kind === "system") {
    assert.equal(bridgeFatalSystem.title, "Bridge fatal");
    assert.match(bridgeFatalSystem.text, /credential revoked/);
    assert.equal(bridgeFatalSystem.producerFactId, `${EXTERNAL_AGENT_ACTIVITY_PROVENANCE}:bridge-fatal-1`);
  }
});

test("external agent activity ingest span fact promotes agent server session and terminal outcome", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);

  const result = await orchestrator.recordExternalAgentActivity("agent-1", {
    schema: EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA,
    coreSessionId: "session-ext-1",
    events: [
      {
        eventId: "missing-hook",
      },
    ],
  }, "server-1");

  assert.deepEqual(result, { acceptedCount: 0, rejectedCount: 1, droppedCount: 0 });
  const fact = traceSpanFactRowForSpanName(sink, traceId, "server.external_agent.activity.ingest");
  assert.equal(fact.row_kind, "span_fact");
  assert.equal(fact.agent_id, "agent-1");
  assert.equal(fact.server_id, "server-1");
  assert.equal(fact.session_id, "session-ext-1");
  assert.equal(fact.outcome, "dropped");
  assert.equal(fact.reason, "no_mappable_events");
  orchestrator.shutdown();
});

test("external bridge fatal activity broadcasts a visible error instead of staying silent", async () => {
  const orchestrator = new BaseActivityLogPersistenceHarness();
  seedActiveAgent(orchestrator, "agent-1", "machine-1", "external-agent");

  const result = await orchestrator.recordExternalAgentActivity("agent-1", {
    schema: EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA,
    coreSessionId: "bridge-core-1",
    events: [{
      eventId: "bridge-fatal-visible-1",
      hookEventName: "BridgeFatal",
      status: "failed",
      errorClass: "Error",
      toolOutput: "unclassified bridge failure",
      occurredAt: "2026-06-12T01:02:06.000Z",
    }],
  }, "server-1");

  assert.deepEqual(result, { acceptedCount: 1, rejectedCount: 0, droppedCount: 0 });
  const emitted = orchestrator.emittedActivityPayloads[0] as Record<string, unknown>;
  assert.equal(orchestrator.emittedActivityPayloads.length, 1);
  assert.equal(emitted.activity, "error");
  assert.equal(emitted.detail, "Bridge fatal: Error");
  assert.equal(emitted.detailKind, "external_activity");

  orchestrator.shutdown();
});

test("Kimi runtime activity skips durable activity log persistence while still streaming to browsers", async () => {
  const clock = new FakeClock();
  clock.advance(1234);
  const orchestrator = new BaseActivityLogPersistenceHarness(clock);
  seedActiveAgent(orchestrator, "agent-1", "machine-1", "kimi");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const entries: TrajectoryEntry[] = [
    { kind: "thinking", text: "plan" },
    { kind: "tool_start", toolName: "bash", toolInput: "{\"cmd\":\"pwd\"}" },
  ];

  assert.equal(
    await orchestrator.callPersistActivityEvent("agent-1", "working", "running", entries),
    false,
  );

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "running",
    entries,
  } as MachineToServerMessage);

  assert.deepEqual(orchestrator.emittedActivityPayloads[0], {
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "running",
    detailKind: "other",
    timestamp: clock.now(),
    serverSeq: 1,
  });

  orchestrator.shutdown();
});

test("Kimi status-only crash loop is circuit-broken before repeated lifecycle projection fanout", async () => {
  const clock = new FakeClock();
  clock.advance(10_000);
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new BaseActivityLogPersistenceHarness(clock, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1", "kimi");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "error",
    detail: "Kimi runtime crashed",
    launchId: "launch-kimi-loop",
    clientSeq: 1,
  } as MachineToServerMessage);

  assert.equal(orchestrator.emittedActivityPayloads.length, 1);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "error",
    activityDetail: "Kimi runtime crashed",
  });

  clock.advance(1_000);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "Restarting Kimi runtime",
    launchId: "launch-kimi-loop",
    clientSeq: 2,
  } as MachineToServerMessage);
  clock.advance(250);
  await flushMicrotasks();

  assert.equal(orchestrator.emittedActivityPayloads.length, 1);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "error",
    activityDetail: "Kimi runtime crashed",
  });
  const dropEvents = sink.getTrace(traceId)
    .filter((span) => span.name === "server.agent.activity.ingest")
    .flatMap((span) => span.events)
    .filter((event) => event.name === "activity.ingest.dropped");
  assert.equal(dropEvents.some((event) => event.attrs?.reason === "kimi_activity_circuit_breaker"), true);

  orchestrator.shutdown();
});

test("Kimi activity circuit breaker still allows user-visible trajectory entries", async () => {
  const clock = new FakeClock();
  clock.advance(20_000);
  const orchestrator = new BaseActivityLogPersistenceHarness(clock);
  seedActiveAgent(orchestrator, "agent-1", "machine-1", "kimi");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "error",
    detail: "Kimi runtime crashed",
    launchId: "launch-kimi-loop",
    clientSeq: 1,
  } as MachineToServerMessage);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "Restarting Kimi runtime",
    launchId: "launch-kimi-loop",
    clientSeq: 2,
  } as MachineToServerMessage);

  const entries: TrajectoryEntry[] = [{ kind: "thinking", text: "Real Kimi output after restart" }];
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "Real Kimi output after restart",
    detailKind: "runtime_progress",
    entries,
    launchId: "launch-kimi-loop",
    clientSeq: 3,
    isHeartbeat: false,
  } as MachineToServerMessage);

  assert.deepEqual(orchestrator.emittedActivityPayloads.at(-1), {
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "Real Kimi output after restart",
    detailKind: "runtime_progress",
    timestamp: clock.now(),
    serverSeq: 2,
    // Daemon-side join keys now thread through the accepted-ingest
    // path into the Socket.IO payload (task #136). The third inbound
    // message above carries `launchId: "launch-kimi-loop"` and
    // `clientSeq: 3` (probeId omitted), so the emit must too.
    launchId: "launch-kimi-loop",
    clientSeq: 3,
  });

  orchestrator.shutdown();
});

test("Kimi activity circuit breaker suppresses repeated same-launch crash entries", async () => {
  const clock = new FakeClock();
  clock.advance(30_000);
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new BaseActivityLogPersistenceHarness(clock, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1", "kimi");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const errorEntries: TrajectoryEntry[] = [{ kind: "status", activity: "error", detail: "Kimi runtime crashed" }];
  const workingEntries: TrajectoryEntry[] = [{ kind: "status", activity: "working", detail: "Restarting Kimi runtime" }];

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "error",
    detail: "Kimi runtime crashed",
    entries: errorEntries,
    launchId: "launch-kimi-loop",
    clientSeq: 1,
  } as MachineToServerMessage);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "Restarting Kimi runtime",
    detailKind: "runtime_progress",
    entries: workingEntries,
    launchId: "launch-kimi-loop",
    clientSeq: 2,
    isHeartbeat: false,
  } as MachineToServerMessage);

  assert.equal(orchestrator.emittedActivityPayloads.length, 2);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "error",
    detail: "Kimi runtime crashed",
    entries: errorEntries,
    launchId: "launch-kimi-loop",
    clientSeq: 3,
  } as MachineToServerMessage);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "Restarting Kimi runtime",
    detailKind: "runtime_progress",
    entries: workingEntries,
    launchId: "launch-kimi-loop",
    clientSeq: 4,
    isHeartbeat: false,
  } as MachineToServerMessage);
  clock.advance(250);
  await flushMicrotasks();

  assert.equal(orchestrator.emittedActivityPayloads.length, 2);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "working",
    activityDetail: "Restarting Kimi runtime",
  });
  const dropEvents = sink.getTrace(traceId)
    .filter((span) => span.name === "server.agent.activity.ingest")
    .flatMap((span) => span.events)
    .filter((event) => event.name === "activity.ingest.dropped");
  assert.equal(
    dropEvents.filter((event) => event.attrs?.reason === "kimi_activity_circuit_breaker").length,
    2,
  );

  orchestrator.shutdown();
});

test("Kimi activity circuit breaker remains scoped away from non-Kimi entries", async () => {
  const clock = new FakeClock();
  clock.advance(40_000);
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new BaseActivityLogPersistenceHarness(clock, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1", "codex");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const entries: TrajectoryEntry[] = [{ kind: "status", activity: "working", detail: "Restarting runtime" }];
  for (const clientSeq of [1, 2]) {
    await orchestrator.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      activity: "working",
      detail: "Restarting runtime",
      entries,
      launchId: "launch-codex-loop",
      clientSeq,
    } as MachineToServerMessage);
  }

  assert.equal(orchestrator.emittedActivityPayloads.length, 2);
  const dropEvents = sink.getTrace(traceId)
    .filter((span) => span.name === "server.agent.activity.ingest")
    .flatMap((span) => span.events)
    .filter((event) => event.name === "activity.ingest.dropped");
  assert.equal(dropEvents.some((event) => event.attrs?.reason === "kimi_activity_circuit_breaker"), false);

  orchestrator.shutdown();
});

test("Kimi runtime profile reports skip durable runtime profile persistence", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1", "kimi");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:runtime_profile",
    agentId: "agent-1",
    facts: {
      runtime: "kimi",
      model: "kimi-code",
      executionMode: "byoc",
      workspacePathRef: { label: "workspace", path: "/work/kimi", reachable: true },
      sessionRef: { label: "session-kimi", runtime: "kimi", path: "/sessions/kimi.jsonl", reachable: true },
    },
  } as MachineToServerMessage);

    const [span] = sink.getTrace(traceId).filter((candidate) => candidate.name === "server.runtime_profile.report.ingest");
    assert.ok(span);
    assert.equal(span.attrs?.outcome, "skipped-kimi-runtime");
    assert.equal(span.attrs?.reason, "unsupported_runtime");
    const runtimeProfileFact = traceSpanFactRowForSpanName(sink, traceId, "server.runtime_profile.report.ingest");
    assert.equal(runtimeProfileFact.row_kind, "span_fact");
    assert.equal(runtimeProfileFact.event_kind, "runtime_profile");
    assert.equal(runtimeProfileFact.agent_id, "agent-1");
    assert.equal(runtimeProfileFact.machine_id, "machine-1");
    assert.equal(runtimeProfileFact.server_id, "server-1");
    assert.equal(runtimeProfileFact.session_id, "session-kimi");
    assert.equal(runtimeProfileFact.outcome, "skipped-kimi-runtime");
    assert.equal(runtimeProfileFact.reason, "unsupported_runtime");

    orchestrator.shutdown();
});

test("APM producer fact on daemon activity entries is bridged into lifecycle writer traces", async () => {
  const clock = new FakeClock();
  clock.advance(2345);
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock, tracer);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const producerFactId = "freshness_decision_fact:unit-held-lineage";
  const entries: TrajectoryEntry[] = [
    { kind: "thinking", producerFactId, text: "checking freshness boundary" },
    {
      kind: "slock_action",
      producerFactId,
      title: "Send held by freshness check",
      text: "unreviewed synced context for this target: 1 message",
    },
  ];

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "held by freshness check",
    entries,
    clientSeq: 1,
    launchId: "current-running-launch",
  } as MachineToServerMessage);

  const projections = lifecycleProjectionAttrs(sink, traceId);
  const liveActivityProjection = projections.find((attrs) => attrs.projection_kind === "live_activity");
  const activityLogProjection = projections.find((attrs) => attrs.projection_kind === "activity_log");

  assert.equal(liveActivityProjection?.apm_source_fact_count, 1);
  assert.equal(liveActivityProjection?.apm_source_fact_id, producerFactId);
  assert.equal(activityLogProjection?.apm_source_fact_count, 1);
  assert.equal(activityLogProjection?.apm_source_fact_id, producerFactId);
  assert.equal(Object.prototype.hasOwnProperty.call(orchestrator.emittedActivityPayloads[0] ?? {}, "entries"), false);
  const recentActivityLog = await orchestrator.listRecentActivityLog("agent-1");
  assert.deepEqual(recentActivityLog, entries.map((entry) => ({
    timestamp: clock.now(),
    entry,
  })));
  assertSurfaceProducerFactLineage(recentActivityLog, [producerFactId], "server durable activity log payload");

  orchestrator.shutdown();
});

test("persisted activity log survives orchestrator restart and remains available for hydration", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const firstClock = new FakeClock();
  firstClock.advance(4321);
  const first = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, firstClock);
  seedActiveAgent(first);
  seedMachineConnection(first, "machine-1", makeFakeWs());

  const entries: TrajectoryEntry[] = [{ kind: "text", text: "done" }];

  await first.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "wrapping up",
    entries,
  } as MachineToServerMessage);

  const expected = await first.listRecentActivityLog("agent-1");
  first.shutdown();

  const second = new PersistedActivityLogDeterministicOrchestrator(persistedLogs);
  assert.deepEqual(await second.listRecentActivityLog("agent-1"), expected);
  second.shutdown();
});

test("persisted activity log keeps older events even though the default hydration window stays at 50", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  for (let i = 0; i < 60; i += 1) {
    clock.advance(1);
    await orchestrator.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      activity: "working",
      detail: `step-${i}`,
      entries: [{ kind: "text", text: `entry-${i}` }],
    } as MachineToServerMessage);
  }

  const defaultWindow = await orchestrator.listRecentActivityLog("agent-1");
  assert.equal(defaultWindow.length, 50);
  assert.equal(defaultWindow[0]?.entry.kind, "text");
  assert.equal((defaultWindow[0]?.entry as { text: string }).text, "entry-10");
  assert.equal((defaultWindow.at(-1)?.entry as { text: string }).text, "entry-59");

  const fullLog = await orchestrator.listRecentActivityLog("agent-1", 200);
  assert.equal(fullLog.length, 60);
  assert.equal((fullLog[0]?.entry as { text: string }).text, "entry-0");
  assert.equal((fullLog.at(-1)?.entry as { text: string }).text, "entry-59");

  orchestrator.shutdown();
});

test("recent persisted transient activity keeps visible agent activity from falling back to online", async () => {
  const timestamp = 12_345;
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>([
    ["agent-1", [{ timestamp, entry: { kind: "status", activity: "working", detail: "Compiling prompt" } }]],
  ]);
  const clock = new FakeClock();
  clock.advance(timestamp);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "working",
    activityDetail: "Compiling prompt",
  });

  orchestrator.shutdown();
});

test("stale persisted transient activity still decays back to online", async () => {
  const timestamp = 12_345;
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>([
    ["agent-1", [{ timestamp, entry: { kind: "status", activity: "thinking", detail: "Old thought" } }]],
  ]);
  const clock = new FakeClock();
  clock.advance(timestamp + 91_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "online",
    activityDetail: "",
  });

  orchestrator.shutdown();
});

test("server-side offline activity broadcasts without explicit trajectory entries are durably persisted", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(20_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  (orchestrator as any).broadcastActivity("agent-1", "offline", "Stopped", "stopped");

  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [{
    timestamp: clock.now(),
    entry: { kind: "status", activity: "offline", activityKind: "offline", detail: "Stopped", detailKind: "stopped" },
  }]);

  orchestrator.shutdown();
});

test("server-side error transition without explicit trajectory entries is durably persisted", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(25_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  (orchestrator as any).broadcastActivity("agent-1", "error", "read_history timed out after 60000ms", "runtime_error");

  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [{
    timestamp: clock.now(),
    entry: { kind: "status", activity: "error", activityKind: "error", detail: "read_history timed out after 60000ms", detailKind: "runtime_error" },
  }]);

  orchestrator.shutdown();
});

test("server-side starting transition without explicit trajectory entries is durably persisted", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(27_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  (orchestrator as any).broadcastActivity("agent-1", "working", "Starting\u2026", "starting");

  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [{
    timestamp: clock.now(),
    entry: { kind: "status", activity: "working", activityKind: "working", detail: "Starting\u2026", detailKind: "starting" },
  }]);
  assert.deepEqual(orchestrator.emittedActivityPayloads.at(-1), {
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "Starting\u2026",
    detailKind: "starting",
    timestamp: clock.now(),
    serverSeq: 1,
  });

  orchestrator.shutdown();
});

test("starting activity log entry is followed by durable idle resolution", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(28_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  (orchestrator as any).broadcastActivity("agent-1", "working", "Starting\u2026", "starting");
  clock.advance(25);
  (orchestrator as any).maybeResolveStartingActivity("agent-1");

  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [
    {
      timestamp: 28_000,
      entry: { kind: "status", activity: "working", activityKind: "working", detail: "Starting\u2026", detailKind: "starting" },
    },
    {
      timestamp: 28_025,
      entry: { kind: "status", activity: "online", activityKind: "online", detail: "", detailKind: "none" },
    },
  ]);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });

  orchestrator.shutdown();
});

test("message IO status-only activity is durably persisted", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(29_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  (orchestrator as any).broadcastActivity("agent-1", "working", "Message received", "message_received");

  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [{
    timestamp: clock.now(),
    entry: { kind: "status", activity: "working", activityKind: "working", detail: "Message received", detailKind: "message_received" },
  }]);

  orchestrator.shutdown();
});

test("probe-timeout busy preserve does not re-mint Message received across sweep cadences", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(60_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock, tracer);
  seedActiveAgent(orchestrator);
  const agentState = (orchestrator as unknown as {
    agentStateCache: Map<string, { runtimeState: string }>;
  }).agentStateCache.get("agent-1");
  assert.ok(agentState);
  agentState.runtimeState = "working";
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs(1));
  orchestrator.deliverToLocalInbox("agent-1", makeAgentMessage("one real delivery", 42));

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:deliver:ack",
    agentId: "agent-1",
    seq: 42,
  } as MachineToServerMessage);
  await flushMicrotasks();
  assert.deepEqual(await orchestrator.receiveMessages("agent-1", false, 0), []);
  const initialLogs = await orchestrator.listRecentActivityLog("agent-1");
  const initialEmitCount = orchestrator.emittedActivityPayloads.length;
  const initialSnapshot = {
    ...(orchestrator as unknown as {
      agentActivity: Map<string, { updatedAt: number; observedAtMs?: number }>;
    }).agentActivity.get("agent-1"),
  };

  for (let cadence = 0; cadence < 2; cadence += 1) {
    clock.advance(30_000);
    (orchestrator as unknown as { refreshStaleTransientActivity(agentId: string, now: number): void })
      .refreshStaleTransientActivity("agent-1", clock.now());
    await flushMicrotasks();
  }

  assert.deepEqual(
    await orchestrator.listRecentActivityLog("agent-1"),
    initialLogs,
    "synthetic timeout repair must not mint another durable Message received fact",
  );
  assert.equal(
    orchestrator.emittedActivityPayloads.length,
    initialEmitCount,
    "synthetic timeout repair must not emit another user-visible Message received fact",
  );
  assert.deepEqual(
    (orchestrator as unknown as {
      agentActivity: Map<string, { updatedAt: number; observedAtMs?: number }>;
    }).agentActivity.get("agent-1"),
    initialSnapshot,
    "synthetic timeout repair must not advance the serving or observed activity clock",
  );

  const preserveSpans = sink.getAllSpans()
    .filter((span) => span.name === "server.agent.stale_activity.busy_preserved");
  assert.equal(preserveSpans.length, 2, "each timeout cadence keeps one closed diagnostic span");
  for (const span of preserveSpans) {
    assert.equal(span.attrs?.authority, "scheduler_repair");
    assert.equal(span.attrs?.previous_activity, "working");
    assert.equal(span.attrs?.candidate_activity, "working");
    assert.equal(span.attrs?.served_activity, "working");
    assert.equal(span.attrs?.projection_outcome, "preserved_without_write");
    assert.equal(span.attrs?.outcome, "preserved_without_write");
    assert.equal(span.attrs?.reason, "synthetic_no_authority");
    assert.equal(span.attrs?.advances_observed_clock, "none");
    const [verdict] = span.events.filter((event) => event.name === "lifecycle_v2.shadow_verdict");
    assert.equal(verdict?.attrs?.shadow_observation_class, "synthetic_diagnostic");
    assert.equal(verdict?.attrs?.shadow_action, "preserve");
    assert.equal(verdict?.attrs?.shadow_reason, "synthetic_no_authority");
    assert.equal(verdict?.attrs?.advances_observed_clock, "none");
  }

  clock.advance(31_000);
  orchestrator.deliverToLocalInbox("agent-1", makeAgentMessage("a later real delivery", 43));
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:deliver:ack",
    agentId: "agent-1",
    seq: 43,
  } as MachineToServerMessage);
  await flushMicrotasks();
  assert.deepEqual(await orchestrator.receiveMessages("agent-1", false, 0), []);

  assert.deepEqual(
    await orchestrator.listRecentActivityLog("agent-1"),
    initialLogs,
    "transport ack must not re-authorize an already stale runtime observation",
  );
  assert.equal(orchestrator.emittedActivityPayloads.length, initialEmitCount);
  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), initialSnapshot);
  const [staleAckSkip] = sink.getAllSpans()
    .flatMap((span) => span.events)
    .filter((event) => event.name === "turn_active.skipped" && event.attrs?.reason === "stale_runtime_observation");
  assert.ok(staleAckSkip, "new seq clears the inbox but keeps the M-17 stale-runtime authority gate");

  clock.advance(30_000);
  (orchestrator as unknown as { refreshStaleTransientActivity(agentId: string, now: number): void })
    .refreshStaleTransientActivity("agent-1", clock.now());
  await flushMicrotasks();
  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), initialLogs);
  assert.equal(orchestrator.emittedActivityPayloads.length, initialEmitCount);
  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), initialSnapshot);

  orchestrator.shutdown();
});

test("control recovery status-only activity is durably persisted", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(29_500);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  (orchestrator as any).broadcastActivity("agent-1", "working", "Restarting stalled codex runtime for queued message", "stalled_recovery");

  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [{
    timestamp: clock.now(),
    entry: { kind: "status", activity: "working", activityKind: "working", detail: "Restarting stalled codex runtime for queued message", detailKind: "stalled_recovery" },
  }]);

  orchestrator.shutdown();
});

test("server-side online status-only pulses remain non-durable", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(30_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  (orchestrator as any).broadcastActivity("agent-1", "online", "");

  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), []);

  orchestrator.shutdown();
});

test("APM 1.6 (6a): working/runtime_progress emits live status but is NOT persisted as a durable activity row", async () => {
  // The Claude `internal_progress` liveness heartbeat arrives as
  // `agent:activity` with { activityKind: "working", detail: "Working",
  // detailKind: "runtime_progress" }. Ratified 口径 (APM 1.6 "6a"): it MUST
  // reach live status (so the agent shows Working during a long turn) but MUST
  // NOT be written to the durable activity log — otherwise every long turn
  // floods the log with repeated "Working" rows. This pins
  // `shouldPersistStatusOnlyActivity` excluding `runtime_progress` end-to-end
  // through `broadcastActivity`, guarding against a future change adding
  // `runtime_progress` to the durable allow-list.
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(31_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  (orchestrator as any).broadcastActivity("agent-1", "working", "Working", "runtime_progress");

  // POSITIVE (live): the runtime_progress heartbeat reached live status. The
  // in-memory cache is updated synchronously and preserves the detailKind, so
  // the read model reflects working + runtime_progress.
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "working",
    activityDetail: "Working",
  });
  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), {
    activity: "working",
    detail: "Working",
    detailKind: "runtime_progress",
    updatedAt: clock.now(),
  });

  // NEGATIVE (durable): no durable activity-log row was written for the
  // runtime_progress heartbeat. This is the noise guard.
  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), []);

  // CONTROL (discriminator): the SAME harness DOES persist a durable row for a
  // working/message_received transition — so the empty-log assertion above is
  // meaningful, not vacuously passing (proves persistence is wired and the
  // runtime_progress row was specifically excluded, not globally suppressed).
  clock.advance(1_000);
  (orchestrator as any).broadcastActivity("agent-1", "working", "Message received", "message_received");
  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [{
    timestamp: clock.now(),
    entry: { kind: "status", activity: "working", activityKind: "working", detail: "Message received", detailKind: "message_received" },
  }]);

  orchestrator.shutdown();
});

test("applyActivityBroadcastAction persists and emits immediately for durable activity payloads", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(35_000);
  const orchestrator = new ActivityBroadcastApplyDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const entries: TrajectoryEntry[] = [{ kind: "text", text: "hello" }];
  orchestrator.callApplyActivityBroadcastAction(
    "persist-and-emit-now",
    "agent-1",
    "working",
    "thinking",
    clock.now(),
    entries,
  );

  await Promise.resolve();

  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [{
    timestamp: clock.now(),
    entry: { kind: "text", text: "hello" },
  }]);
  assert.deepEqual(orchestrator.emittedActivityPayloads.at(-1), {
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "thinking",
    detailKind: "other",
    timestamp: clock.now(),
    serverSeq: 1,
  });
  orchestrator.shutdown();
});

test("applyActivityBroadcastAction threads launchId/clientSeq/probeId/producerFactId into the immediate-emit Socket payload (task #136)", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(50_000);
  const orchestrator = new ActivityBroadcastApplyDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const entries: TrajectoryEntry[] = [{ kind: "text", text: "thinking aloud" }];
  orchestrator.callApplyActivityBroadcastAction(
    "persist-and-emit-now",
    "agent-1",
    "working",
    "deep thought",
    clock.now(),
    entries,
    { launchId: "L-7", clientSeq: 42, probeId: "P-xyz", producerFactId: "daemon_activity:agent-1:L-7:42" },
  );

  await Promise.resolve();

  assert.deepEqual(orchestrator.emittedActivityPayloads.at(-1), {
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "deep thought",
    detailKind: "other",
    timestamp: clock.now(),
    serverSeq: 1,
    // serverSeq is the server's outbound id; launchId/clientSeq are the
    // daemon-side join keys preserved for ScopeDB exact-join (task #136).
    launchId: "L-7",
    clientSeq: 42,
    probeId: "P-xyz",
    producerFactId: "daemon_activity:agent-1:L-7:42",
  });
  orchestrator.shutdown();
});

test("applyActivityBroadcastAction omits absent launchId/clientSeq/probeId from the payload (no `legacy` fabrication; task #136)", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(55_000);
  const orchestrator = new ActivityBroadcastApplyDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const entries: TrajectoryEntry[] = [{ kind: "text", text: "legacy-shape" }];
  orchestrator.callApplyActivityBroadcastAction(
    "persist-and-emit-now",
    "agent-1",
    "working",
    "old-daemon",
    clock.now(),
    entries,
    // No join keys — emulates an inbound daemon `agent:activity` with
    // launchId/clientSeq absent (older daemons). The Socket payload must
    // omit the fields entirely; feedback-export classifies the row as
    // `join_key_missing`, never `legacy`.
  );

  await Promise.resolve();

  const emitted = orchestrator.emittedActivityPayloads.at(-1) as Record<string, unknown>;
  assert.equal(emitted.launchId, undefined);
  assert.equal(emitted.clientSeq, undefined);
  assert.equal(emitted.probeId, undefined);
  assert.equal(emitted.producerFactId, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(emitted, "launchId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(emitted, "clientSeq"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(emitted, "probeId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(emitted, "producerFactId"), false);
  // Existing payload shape still holds.
  assert.equal(emitted.agentId, "agent-1");
  assert.equal(emitted.activity, "working");
  assert.equal(emitted.serverSeq, 1);
  orchestrator.shutdown();
});

test("applyActivityBroadcastAction debounces non-durable status-only pulses", () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(40_000);
  const orchestrator = new ActivityBroadcastApplyDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  orchestrator.callApplyActivityBroadcastAction(
    "debounce-only",
    "agent-1",
    "online",
    "",
    clock.now(),
    [],
  );

  assert.equal((orchestrator as any).activityDebounceTimers.has("agent-1"), true);
  assert.deepEqual(orchestrator.emittedActivityPayloads, []);
  assert.deepEqual(persistedLogs.get("agent-1") ?? [], []);
  orchestrator.shutdown();
});

test("buggy cross-replica fallback semantics would misclassify the same agent as offline", async () => {
  const store = new BuggyReplicaFallbackStore();
  store.machineReplicas.add("machine-1");

  const orchestrator = new DeterministicAgentOrchestrator(store);
  seedActiveAgent(orchestrator);

  const activity = await orchestrator.getActivity("agent-1");
  assert.deepEqual(activity, { activity: "offline", activityDetail: "" });

  orchestrator.shutdown();
});

test("pong refresh self-heals a missing machine replica mapping", async () => {
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new DeterministicAgentOrchestrator(store);
  seedActiveAgent(orchestrator);

  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "" });

  await orchestrator.handleMachineMessage("machine-1", { type: "pong" } as MachineToServerMessage);

  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });

  orchestrator.shutdown();
});

test("expire-only refresh semantics would fail to self-heal after pong", async () => {
  const store = new ExpireOnlyRefreshStore();
  const orchestrator = new DeterministicAgentOrchestrator(store);
  seedActiveAgent(orchestrator);

  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "" });

  await orchestrator.handleMachineMessage("machine-1", { type: "pong" } as MachineToServerMessage);

  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "" });

  orchestrator.shutdown();
});

test("fresh remote cached activity does not mask a missing machine replica heartbeat", async () => {
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new DeterministicAgentOrchestrator(store);
  seedActiveAgent(orchestrator);
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "still-running",
    updatedAt: Date.now(),
  });

  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "" });

  orchestrator.shutdown();
});

test("fresh remote cached offline state does not mask a recovered online machine", async () => {
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  const orchestrator = new DeterministicAgentOrchestrator(store);
  seedActiveAgent(orchestrator);
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "offline",
    detail: "",
    updatedAt: Date.now(),
  });

  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });

  orchestrator.shutdown();
});

test("local cached activity remains authoritative over remote soft hints while the machine is connected here", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const store = new InMemoryReplicaStateStore();
  await store.setAgentActivity("agent-1", "offline", "", "none");
  const orchestrator = new DeterministicAgentOrchestrator(store, undefined, tracer);
  const ws = makeFakeWs(1);

  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", ws);
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "local-run",
    updatedAt: Date.now(),
  });

  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "working",
    activityDetail: "local-run",
  });
  assertResolveSpanAgentIdentity(sink, traceId, "agent-1", "local-cache");

  orchestrator.shutdown();
});

test("getActivity does not consult the local shadow for a no-machine agent (de-shadow CC-005)", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);

  (orchestrator as any).agentStateCache.set("agent-1", {
    status: "active",
    machineId: null,
    sessionId: null,
    expectedLaunchId: null,
    launchGuardMode: "legacy",
    serverId: "server-1",
    name: "agent-1",
    displayName: null,
    description: null,
    model: "gpt-5",
    runtime: "codex",
    runtimeState: "running_idle",
    reasoningEffort: null,
    envVars: null,
  });
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "stale-soft-state",
    updatedAt: Date.now() - 5_000,
  });

  // No machine => non-owner. Per the cross-replica cache-coherence contract
  // (CC-005), the local in-memory shadow has no authority and must NOT be
  // consulted; the agent derives offline from reachability instead of surfacing
  // the stale "working" shadow.
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "offline",
    activityDetail: "",
  });

  // The local shadow is never processed: none of the activity-hint resolution
  // trace events fire (previously the shadow was seen-then-ignored).
  const events = eventsForSpan(sink, traceId, "server.agent.activity.resolve");
  assert.equal(events.some((event) => event.name === "activity.hint.seen"), false);
  assert.equal(events.some((event) => event.name === "activity.hint.ignored"), false);
  assert.equal(events.some((event) => event.name === "activity.hint.candidate"), false);
  assert.equal(events.some((event) => event.name === "activity.hint.normalized"), false);

  orchestrator.shutdown();
});

test("getActivity derives offline when an active agent has no machine and no soft hints", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);

  (orchestrator as any).agentStateCache.set("agent-1", {
    status: "active",
    machineId: null,
    sessionId: null,
    expectedLaunchId: null,
    launchGuardMode: "legacy",
    serverId: "server-1",
    name: "agent-1",
    displayName: null,
    description: null,
    model: "gpt-5",
    runtime: "codex",
    runtimeState: "running_idle",
    reasoningEffort: null,
    envVars: null,
  });

  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "offline",
    activityDetail: "",
  });

  const [span] = sink.getTrace(traceId);
  assert.equal(span?.name, "server.agent.activity.resolve");
  assert.deepEqual(span?.attrs, {
    agent_id: "agent-1",
    agent_id_present: true,
    outcome: "offline",
    source: "derived",
  });
  assert.deepEqual(span?.events, []);

  orchestrator.shutdown();
});

test("getActivity can link resolve spans to a request parent while keeping the HTTP root presence-only", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);
  seedActiveAgent(orchestrator, "agent-raw-id");
  (orchestrator as any).agentStateCache.get("agent-raw-id").machineId = null;
  const parent = tracer.startSpan("server.http.request", {
    surface: "server",
    kind: "server",
    attrs: { route_pattern: "/api/agents" },
  });

  assert.deepEqual(await orchestrator.getActivity("agent-raw-id", { parent: parent.context }), {
    activity: "offline",
    activityDetail: "",
  });
  parent.end("ok");

  const span = sink.getTrace(traceId).find((candidate) => candidate.name === "server.agent.activity.resolve");
  assert.ok(span);
  assert.equal(span.context.parentSpanId, parent.context.spanId);
  assert.equal(span.context.traceId, parent.context.traceId);
  assert.equal(span.attrs?.agent_id, "agent-raw-id");
  assert.equal(span.attrs?.agent_id_present, true);
  const requestSpan = sink.getTrace(traceId).find((candidate) => candidate.name === "server.http.request");
  assert.ok(requestSpan);
  assert.equal(Object.values(requestSpan.attrs ?? {}).includes("agent-raw-id"), false);
  orchestrator.shutdown();
});

test("loadActivityHintResolutionPlanInput marks fresh local-cache snapshots as fresh and locally reachable", async () => {
  const orchestrator = new ActivityHintInputDeterministicOrchestrator();
  const ws = makeFakeWs(1);
  const now = Date.now();

  seedMachineConnection(orchestrator, "machine-1", ws);

  assert.deepEqual(
    await orchestrator.callLoadActivityHintResolutionPlanInput(
      { status: "active", machineId: "machine-1" },
      { activity: "working", detail: "local-run", detailKind: "other", updatedAt: now },
      "local-cache",
    ),
    {
      hasStoppedOfflineHint: false,
      reachability: "local",
      shouldTrustRecoveredOfflineHint: false,
      source: "local-cache",
      isFreshLocalCache: true,
    },
  );

  orchestrator.shutdown();
});

test("loadActivityHintResolutionPlanInput marks recovered remote offline hints for ignore", async () => {
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  const orchestrator = new ActivityHintInputDeterministicOrchestrator(store);

  assert.deepEqual(
    await orchestrator.callLoadActivityHintResolutionPlanInput(
      { status: "active", machineId: "machine-1" },
      { activity: "offline", detail: "", detailKind: "none", updatedAt: Date.now() },
      "redis",
    ),
    {
      hasStoppedOfflineHint: false,
      reachability: "remote",
      shouldTrustRecoveredOfflineHint: true,
      source: "redis",
      isFreshLocalCache: true,
    },
  );

  orchestrator.shutdown();
});

test("loadActivityHintResolutionPlanInput preserves explicit stopped offline hints", async () => {
  const orchestrator = new ActivityHintInputDeterministicOrchestrator();

  assert.deepEqual(
    await orchestrator.callLoadActivityHintResolutionPlanInput(
      { status: "active", machineId: "machine-1" },
      { activity: "offline", detail: "Stopped", detailKind: "stopped", updatedAt: Date.now() },
      "local-cache",
    ),
    {
      hasStoppedOfflineHint: true,
      reachability: "offline",
      shouldTrustRecoveredOfflineHint: false,
      source: "local-cache",
      isFreshLocalCache: true,
    },
  );

  orchestrator.shutdown();
});

test("stale agent activity from a previous launch does not overwrite the current launch", async () => {
  const orchestrator = new LaunchGuardDeterministicAgentOrchestrator();
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs(1));

  await orchestrator.startAgent("agent-1");
  const launch1 = orchestrator.startMessages[0]!.launchId!;
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-1",
    launchId: launch1,
  });
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:status",
    agentId: "agent-1",
    status: "inactive",
    launchId: launch1,
  });

  await orchestrator.startAgent("agent-1");
  const launch2 = orchestrator.startMessages[1]!.launchId!;
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-2",
    launchId: launch2,
  });
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "current-launch",
    launchId: launch2,
  });
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "offline",
    detail: "stale-launch",
    launchId: launch1,
  });

  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "working",
    activityDetail: "current-launch",
  });

  orchestrator.shutdown();
});

test("stale inactive status from a previous launch does not kill the current launch", async () => {
  const orchestrator = new LaunchGuardDeterministicAgentOrchestrator();
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs(1));

  await orchestrator.startAgent("agent-1");
  const launch1 = orchestrator.startMessages[0]!.launchId!;
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-1",
    launchId: launch1,
  });
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:status",
    agentId: "agent-1",
    status: "inactive",
    launchId: launch1,
  });

  await orchestrator.startAgent("agent-1");
  const launch2 = orchestrator.startMessages[1]!.launchId!;
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-2",
    launchId: launch2,
  });
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:status",
    agentId: "agent-1",
    status: "inactive",
    launchId: launch1,
  });

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "active");

  orchestrator.shutdown();
});

test("reconnect replay with the current launchId is accepted in guarded mode", async () => {
  const orchestrator = new LaunchGuardDeterministicAgentOrchestrator();
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs(1));

  await orchestrator.startAgent("agent-1");
  const launch1 = orchestrator.startMessages[0]!.launchId!;

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-replay",
    launchId: launch1,
  });

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").sessionId, "session-replay");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").expectedLaunchId, launch1);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").launchGuardMode, "guarded");

  orchestrator.shutdown();
});

test("legacy lifecycle events are accepted in legacy mode but rejected once the agent is guarded", async () => {
  const orchestrator = new LaunchGuardDeterministicAgentOrchestrator();
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs(1));
  seedActiveAgent(orchestrator);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "legacy-accepted",
  });

  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "working",
    activityDetail: "legacy-accepted",
  });

  await orchestrator.startAgent("agent-1");
  const launch1 = orchestrator.startMessages[0]!.launchId!;
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").expectedLaunchId, launch1);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "offline",
    detail: "legacy-rejected-after-guard",
  });

  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "online",
    activityDetail: "",
  });
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").expectedLaunchId, launch1);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").launchGuardMode, "guarded");

  orchestrator.shutdown();
});

test("guarded rejected lifecycle signals still resolve optimistic starting activity", async () => {
  const scenarios: Array<{
    name: string;
    configureCurrent?: (orchestrator: LaunchGuardDeterministicAgentOrchestrator) => void;
    message: MachineToServerMessage;
  }> = [
    {
      name: "stale status launchId",
      message: { type: "agent:status", agentId: "agent-1", status: "inactive", launchId: "stale-launch" },
    },
    {
      name: "legacy status without launchId",
      configureCurrent: (orchestrator) => {
        (orchestrator as any).agentActivity.set("agent-1", {
          activity: "working",
          detail: "Starting…",
          updatedAt: (orchestrator as any).clock.now(),
        });
      },
      message: { type: "agent:status", agentId: "agent-1", status: "inactive" },
    },
    {
      name: "stale session launchId",
      message: { type: "agent:session", agentId: "agent-1", sessionId: "stale-session", launchId: "stale-launch" },
    },
    {
      name: "stale activity launchId while runtime_starting is visible",
      configureCurrent: (orchestrator) => {
        (orchestrator as any).agentActivity.set("agent-1", {
          activity: "working",
          detail: "Runtime is starting",
          detailKind: "runtime_starting",
          updatedAt: (orchestrator as any).clock.now(),
        });
      },
      message: {
        type: "agent:activity",
        agentId: "agent-1",
        activity: "working",
        detail: "stale-payload-must-not-apply",
        launchId: "stale-launch",
      },
    },
  ];

  for (const scenario of scenarios) {
    const orchestrator = new LaunchGuardDeterministicAgentOrchestrator();
    seedMachineConnection(orchestrator, "machine-1", makeFakeWs(1));
    seedActiveAgent(orchestrator);

    await orchestrator.startAgent("agent-1");
    const launch1 = orchestrator.startMessages[0]!.launchId!;
    scenario.configureCurrent?.(orchestrator);

    assert.equal((orchestrator as any).agentStateCache.get("agent-1").expectedLaunchId, launch1, scenario.name);
    assert.deepEqual(await orchestrator.getActivity("agent-1"), {
      activity: "working",
      activityDetail: scenario.name.includes("runtime_starting") ? "Runtime is starting" : "Starting…",
    }, scenario.name);

    await orchestrator.handleMachineMessage("machine-1", scenario.message);

    const cached = (orchestrator as any).agentStateCache.get("agent-1");
    assert.equal(cached.expectedLaunchId, launch1, scenario.name);
    assert.equal(cached.launchGuardMode, "guarded", scenario.name);
    assert.equal(cached.sessionId, null, scenario.name);
    assert.deepEqual(await orchestrator.getActivity("agent-1"), {
      activity: "online",
      activityDetail: "",
    }, scenario.name);

    orchestrator.shutdown();
  }
});

test("old daemon without launchId support does not get launch guard", async () => {
  const orchestrator = new LaunchGuardDeterministicAgentOrchestrator();
  // Simulate an old daemon (version 0.30.0, before launchId support)
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs(1), "0.30.0");

  await orchestrator.startAgent("agent-1");
  const startMsg = orchestrator.startMessages[0]!;
  // Old daemon should not receive a launchId
  assert.equal(startMsg.launchId, undefined);
  // Agent should be in legacy mode (no guard)
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").launchGuardMode, "legacy");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").expectedLaunchId, null);

  // Full lifecycle without launchId — all events should be accepted
  // 1. Session init (old daemon sends session without launchId)
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-old-1",
  });
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").sessionId, "session-old-1");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "active");

  // 2. Activity updates
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "old-daemon-working",
  });
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "working",
    activityDetail: "old-daemon-working",
  });

  // 3. Status inactive (agent stops)
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:status",
    agentId: "agent-1",
    status: "inactive",
  });
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "inactive");

  // 4. Restart — still no launch guard for old daemon
  await orchestrator.startAgent("agent-1");
  const startMsg2 = orchestrator.startMessages[1]!;
  assert.equal(startMsg2.launchId, undefined);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").launchGuardMode, "legacy");

  // 5. New session after restart is accepted
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-old-2",
  });
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").sessionId, "session-old-2");

  orchestrator.shutdown();
});

test("old daemon with null version does not get launch guard", async () => {
  const orchestrator = new LaunchGuardDeterministicAgentOrchestrator();
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs(1), null);

  await orchestrator.startAgent("agent-1");
  const startMsg = orchestrator.startMessages[0]!;
  assert.equal(startMsg.launchId, undefined);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").launchGuardMode, "legacy");

  orchestrator.shutdown();
});

test("daemon versions from last week (v0.28.x, v0.29.x) work without launch guard", async () => {
  for (const version of ["0.27.1-alpha.0", "0.28.0", "0.28.1-alpha.3", "0.29.0", "0.29.1-alpha.0", "0.30.0"]) {
    const orchestrator = new LaunchGuardDeterministicAgentOrchestrator();
    seedMachineConnection(orchestrator, "machine-1", makeFakeWs(1), version);

    await orchestrator.startAgent("agent-1");
    assert.equal(orchestrator.startMessages.at(-1)!.launchId, undefined, `v${version} should not get launchId`);
    assert.equal((orchestrator as any).agentStateCache.get("agent-1").launchGuardMode, "legacy", `v${version} should be legacy`);

    // Lifecycle events without launchId should work
    await orchestrator.handleMachineMessage("machine-1", {
      type: "agent:session",
      agentId: "agent-1",
      sessionId: `session-${version}`,
    });
    assert.equal((orchestrator as any).agentStateCache.get("agent-1").sessionId, `session-${version}`, `v${version} session should be accepted`);

    orchestrator.shutdown();
  }
});

test("modern daemon (>= 0.30.1) gets launch guard as before", async () => {
  for (const version of ["0.30.1", "0.30.1-alpha.1", "0.31.0", "1.0.0"]) {
    const orchestrator = new LaunchGuardDeterministicAgentOrchestrator();
    seedMachineConnection(orchestrator, "machine-1", makeFakeWs(1), version);

    await orchestrator.startAgent("agent-1");
    const launchId = orchestrator.startMessages.at(-1)!.launchId;
    assert.ok(launchId, `v${version} should get launchId`);
    assert.equal((orchestrator as any).agentStateCache.get("agent-1").launchGuardMode, "guarded", `v${version} should be guarded`);
    assert.equal((orchestrator as any).agentStateCache.get("agent-1").expectedLaunchId, launchId, `v${version} should have expectedLaunchId`);

    orchestrator.shutdown();
  }
});

test("failed guarded start clears the launch guard and releases the wake lock", async () => {
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new FailingLaunchGuardDeterministicAgentOrchestrator(store);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs(1), "1.0.0");

  await assert.rejects(() => orchestrator.startAgent("agent-1"), /Machine offline\. Please start your local daemon\./);

  const startMsg = orchestrator.startMessages[0]!;
  assert.ok(startMsg.launchId);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").launchGuardMode, "legacy");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").expectedLaunchId, null);
  assert.equal(store.wakeLocks.size, 0);

  orchestrator.shutdown();
});

test("agent inactive status clears the launch guard and releases the wake lock", async () => {
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new LaunchGuardDeterministicAgentOrchestrator(store);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs(1), "1.0.0");

  await orchestrator.startAgent("agent-1");
  assert.equal(store.wakeLocks.size, 1);

  const startMsg = orchestrator.startMessages[0]!;
  assert.ok(startMsg.launchId);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").launchGuardMode, "guarded");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").expectedLaunchId, startMsg.launchId);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:status",
    agentId: "agent-1",
    status: "inactive",
    launchId: startMsg.launchId,
  } as MachineToServerMessage);

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "inactive");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").launchGuardMode, "legacy");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").expectedLaunchId, null);
  assert.equal(store.wakeLocks.size, 0);

  orchestrator.shutdown();
});

test("getActivity resolution order ignores recovered offline hints before falling through to recent persisted and then derived fallback", async () => {
  const clock = new FakeClock();
  clock.advance(100_000);
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  store.agentActivities.set("agent-1", {
    activity: "offline",
    detail: "",
    detailKind: "none",
    updatedAt: clock.now(),
  });
  const orchestrator = new ActivityResolutionDeterministicOrchestrator(
    store,
    {
      activity: "working",
      detail: "persisted-run",
      detailKind: "other",
      updatedAt: clock.now() - 10_000,
    },
    clock,
  );

  seedActiveAgent(orchestrator);
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "offline",
    detail: "",
    detailKind: "none",
    updatedAt: clock.now(),
  });

  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "working",
    activityDetail: "persisted-run",
  });

  orchestrator.setPersistedHint({
    activity: "working",
    detail: "persisted-run",
    detailKind: "other",
    updatedAt: clock.now() - 91_000,
  });

  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "online",
    activityDetail: "",
  });

  orchestrator.shutdown();
});

test("getActivity resolution order prefers fresh redis activity over recent persisted fallback when local cache is absent", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(100_000);
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  store.agentActivities.set("agent-1", {
    activity: "working",
    detail: "remote-run",
    detailKind: "other",
    updatedAt: clock.now(),
  });
  const orchestrator = new ActivityResolutionDeterministicOrchestrator(
    store,
    {
      activity: "thinking",
      detail: "persisted-thought",
      detailKind: "other",
      updatedAt: clock.now() - 5_000,
    },
    clock,
    tracer,
  );

  seedActiveAgent(orchestrator);

  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "working",
    activityDetail: "remote-run",
  });
  assertResolveSpanAgentIdentity(sink, traceId, "agent-1", "redis");

  assert.equal(
    (orchestrator as any).agentActivity.get("agent-1"),
    undefined,
    "non-owner read-through must not populate the local serving map",
  );

  orchestrator.shutdown();
});

test("M-22: kernel-enabled non-owner Redis read-through serves the owner mirror without mutating local authority", async () => {
  await withKernelEnvAsync(true, async () => {
    const { sink, tracer, traceId } = makeDeterministicTracer();
    const clock = new FakeClock();
    clock.advance(100_000);
    const store = new InMemoryReplicaStateStore();
    store.machineReplicas.add("machine-1");
    store.agentActivities.set("agent-1", {
      activity: "working",
      detail: "owner-mirror-working",
      detailKind: "running_command",
      updatedAt: clock.now(),
    });
    const orchestrator = new ActivityResolutionDeterministicOrchestrator(store, null, clock, tracer);

    seedActiveAgent(orchestrator);
    const staleLocal = {
      activity: "offline" as const,
      detail: "",
      detailKind: "none" as const,
      updatedAt: clock.now() - 5_000,
    };
    (orchestrator as any).agentActivity.set("agent-1", staleLocal);

    assert.deepEqual(await orchestrator.getActivity("agent-1"), {
      activity: "working",
      activityDetail: "owner-mirror-working",
    });
    assert.deepEqual(
      (orchestrator as any).agentActivity.get("agent-1"),
      staleLocal,
      "read-through must not promote the remote mirror into this replica's local serving authority",
    );
    assertResolveSpanAgentIdentity(sink, traceId, "agent-1", "redis");
    const resolveSpan = sink.getTrace(traceId).find((span) =>
      span.name === "server.agent.activity.resolve" && span.attrs?.source === "redis");
    assert.ok(resolveSpan);
    assert.equal(resolveSpan.attrs?.outcome, "working");
    const candidateIndex = resolveSpan.events.findIndex((event) => event.name === "activity.hint.candidate");
    const appliedIndex = resolveSpan.events.findIndex((event) => event.name === "activity.hint.applied");
    assert.ok(candidateIndex >= 0, "owner-mirror resolution must record its candidate");
    assert.ok(appliedIndex > candidateIndex, "applied must follow candidate on the same resolve span");
    const candidate = resolveSpan.events[candidateIndex];
    const applied = resolveSpan.events[appliedIndex];
    assert.deepEqual(candidate?.attrs, {
      hint_source: "redis",
      candidate_activity: "working",
      resolved_activity: "working",
    });
    assert.deepEqual(applied?.attrs, {
      hint_source: "redis",
      candidate_activity: "working",
      served_activity: "working",
      write_action: "none",
      arbitration_reason: "owner_mirror_read_through",
      resolved_activity: "working",
      next_activity: "working",
      action: "none",
      reason: "owner_mirror_read_through",
    });
    assert.equal(
      applied?.attrs?.served_activity,
      resolveSpan.attrs?.outcome,
      "the applied served value must equal the root outcome served to the caller",
    );
    assert.equal(resolveSpan.events.some((event) => event.name === "activity.hint.returned"), false);
    const rows = traceEventRowsForSpanName(sink, traceId, "server.agent.activity.resolve");
    const appliedRow = rows.find((row) => row.event_name === "activity.hint.applied");
    assert.equal(appliedRow?.agent_id, "agent-1", "applied decision must retain an entity filter axis");
    assert.equal(appliedRow?.resolved_activity, "working");
    assert.equal(appliedRow?.next_activity, "working");
    assert.equal(appliedRow?.action, "none");
    assert.equal(appliedRow?.reason, "owner_mirror_read_through");

    orchestrator.shutdown();
  });
});

test("M-22 trace: available Redis miss falls through to persisted activity without hint decisions or writer shadow", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(100_000);
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  const orchestrator = new ActivityResolutionDeterministicOrchestrator(
    store,
    {
      activity: "working",
      detail: "persisted-fallback",
      detailKind: "running_command",
      updatedAt: clock.now(),
    },
    clock,
    tracer,
  );
  seedActiveAgent(orchestrator);

  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "working",
    activityDetail: "persisted-fallback",
  });
  const resolveSpan = sink.getTrace(traceId).find((span) =>
    span.name === "server.agent.activity.resolve" && span.attrs?.source === "persisted");
  assert.ok(resolveSpan, "Redis miss must retain the persisted fallback");
  assert.equal(resolveSpan.events.some((event) => event.name === "activity.hint.candidate"), false);
  assert.equal(resolveSpan.events.some((event) => event.name === "activity.hint.applied"), false);
  assert.equal(
    sink.getAllSpans().some((span) =>
      span.name === "server.agent.activity_writer.shadow" && span.attrs?.writer_site === "hint_resolution"),
    false,
  );

  orchestrator.shutdown();
});

test("M-22 trace: unavailable Redis keeps derived fallback without hint decisions or writer shadow", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new ActivityResolutionDeterministicOrchestrator(
    new RedisUnavailableReplicaStateStore(),
    null,
    new FakeClock(),
    tracer,
  );
  seedActiveAgent(orchestrator);
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "thinking",
    detail: "non-owner-shadow",
    detailKind: "other",
    updatedAt: Date.now(),
  });

  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "offline",
    activityDetail: "",
  });
  const resolveSpan = sink.getTrace(traceId).find((span) =>
    span.name === "server.agent.activity.resolve" && span.attrs?.source === "derived");
  assert.ok(resolveSpan, "Redis unavailability must retain the derived fallback");
  assert.equal(resolveSpan.events.some((event) => event.name === "activity.hint.candidate"), false);
  assert.equal(resolveSpan.events.some((event) => event.name === "activity.hint.applied"), false);
  assert.equal(
    sink.getAllSpans().some((span) =>
      span.name === "server.agent.activity_writer.shadow" && span.attrs?.writer_site === "hint_resolution"),
    false,
  );

  orchestrator.shutdown();
});

test("getActivity returns persisted runtime error state before derived online status", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(100_000);
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  const orchestrator = new ActivityResolutionDeterministicOrchestrator(
    store,
    null,
    clock,
    tracer,
  );

  seedActiveAgent(orchestrator);
  (orchestrator as any).updateCache("agent-1", {
    lastRuntimeError: {
      message: "Built-in provider authentication failed. Check this agent's provider API key and region/provider selection, then retry starting this agent.",
      at: new Date(clock.now() - 120_000).toISOString(),
      launchId: "launch-auth",
      actionRequired: true,
    },
  });

  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "error",
    activityDetail: "Built-in provider authentication failed. Check this agent's provider API key and region/provider selection, then retry starting this agent.",
  });
  assert.equal(
    store.agentRuntimeErrors.get("agent-1")?.fingerprint,
    fingerprintAgentRuntimeError((orchestrator as any).agentStateCache.get("agent-1")?.lastRuntimeError ?? null),
  );
  assertResolveSpanAgentIdentity(sink, traceId, "agent-1", "runtime-error-state");

  orchestrator.shutdown();
});

test("detailKind-less legacy error remains visible for compatibility but cannot persist runtime error state", async () => {
  const clock = new FakeClock();
  clock.advance(123_456);
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new DeterministicAgentOrchestrator(store, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "error",
    detail: "Built-in provider authentication failed",
    launchId: "launch-auth",
  });
  await flushMicrotasks();

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").lastRuntimeError, null);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "error",
    activityDetail: "Built-in provider authentication failed",
  });
  assert.equal(store.agentActivities.get("agent-1")?.activity, "error");
  assert.equal(store.agentActivities.get("agent-1")?.detail, "Built-in provider authentication failed");

  orchestrator.shutdown();
});

test("agent:activity status error entry alone cannot set agent runtime error state", async () => {
  const clock = new FakeClock();
  clock.advance(234_567);
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new DeterministicAgentOrchestrator(store, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "Message received",
    launchId: "launch-auth",
    entries: [
      { kind: "text", text: "Error: 401: Authentication Fails, api key invalid" },
      { kind: "status", activity: "error", detail: "401: Authentication Fails, api key invalid" },
    ],
  });
  await flushMicrotasks();

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").lastRuntimeError, null);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "working",
    activityDetail: "Message received",
  });
  assert.equal(store.agentActivities.get("agent-1")?.activity, "working");
  assert.equal(store.agentActivities.get("agent-1")?.detail, "Message received");

  orchestrator.shutdown();
});

test("runtime_error detailKind is the runtime-error set authority even when legacy activity disagrees", async () => {
  const clock = new FakeClock();
  clock.advance(345_678);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "Provider authentication failed",
    detailKind: "runtime_error",
    entries: [{
      kind: "status",
      activity: "working",
      activityKind: "working",
      detail: "Provider authentication failed",
      detailKind: "runtime_error",
    }],
    launchId: "launch-auth",
    isHeartbeat: false,
  });
  await flushMicrotasks();

  assert.deepEqual((orchestrator as any).agentStateCache.get("agent-1").lastRuntimeError, {
    message: "Provider authentication failed",
    at: new Date(clock.now()).toISOString(),
    launchId: "launch-auth",
    actionRequired: true,
  });
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "error",
    activityDetail: "Provider authentication failed",
  });
  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [{
    timestamp: clock.now(),
    entry: {
      kind: "status",
      activity: "error",
      activityKind: "error",
      detail: "Provider authentication failed",
      detailKind: "runtime_error",
    },
  }]);

  orchestrator.shutdown();
});

test("probe-timeout fallback preserves a runtime error that arrives after the stale-busy probe", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let probeTimeout: (() => void) | null = null;
  (globalThis as any).setTimeout = ((callback: () => void, ms?: number, ...args: any[]) => {
    if (ms === 5_000) {
      probeTimeout = callback;
      return { probeTimeout: true };
    }
    return realSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout;
  (globalThis as any).clearTimeout = ((timer: unknown) => {
    if ((timer as any)?.probeTimeout) return;
    return realClearTimeout(timer as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;

  const clock = new FakeClock();
  clock.advance(120_000);
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new DeterministicAgentOrchestrator(store, clock);
  try {
    seedActiveAgent(orchestrator);
    const ws = makeFakeWs();
    seedMachineConnection(orchestrator, "machine-1", ws);
    (orchestrator as any).agentActivity.set("agent-1", {
      activity: "working",
      detail: "Starting…",
      detailKind: "runtime_starting",
      observedAtMs: 0,
      updatedAt: 0,
    });

    (orchestrator as unknown as { sweepStaleActivities(): void }).sweepStaleActivities();
    await flushMicrotasks();
    const probeMessage = ws.sent.map((payload) => JSON.parse(payload)).find((message) =>
      message.type === "agent:activity_probe"
      && message.agentId === "agent-1"
      && message.purpose === "sweep");
    assert.ok(probeMessage, "a stale busy snapshot must enter the real activity-probe path");
    assert.ok(probeTimeout, "the real activity-probe expiry callback must be armed");
    assert.ok(
      (orchestrator as any).pendingActivityProbes.has(probeMessage.probeId),
      "the dispatched probe must remain pending until reply or expiry",
    );

    await orchestrator.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      activity: "error",
      activityKind: "error",
      detail: "Built-in provider authentication failed",
      detailKind: "runtime_error",
      entries: [{
        kind: "status",
        activity: "error",
        activityKind: "error",
        detail: "Built-in provider authentication failed",
        detailKind: "runtime_error",
      }],
      launchId: "launch-auth",
      isHeartbeat: false,
    } as MachineToServerMessage);
    await flushMicrotasks();

    const expectedRuntimeError = {
      message: "Built-in provider authentication failed",
      at: new Date(clock.now()).toISOString(),
      launchId: "launch-auth",
      actionRequired: true,
    };
    assert.deepEqual((orchestrator as any).agentStateCache.get("agent-1")?.lastRuntimeError, expectedRuntimeError);
    assert.equal((orchestrator as any).pendingActivityProbes.size, 1);

    // Fire the callback armed by issueActivityProbe itself. This must both
    // retire the pending probe and traverse its timeout fallback without
    // normalizing the newer authoritative runtime error online.
    clock.advance((AgentOrchestrator as any).ACTIVITY_PROBE_TIMEOUT_MS);
    const capturedProbeTimeout = probeTimeout as (() => void) | null;
    assert.ok(capturedProbeTimeout);
    capturedProbeTimeout();
    await flushMicrotasks();

    assert.equal((orchestrator as any).pendingActivityProbes.size, 0);
    assert.deepEqual((orchestrator as any).agentStateCache.get("agent-1")?.lastRuntimeError, expectedRuntimeError);
    assert.equal((orchestrator as any).agentActivity.get("agent-1")?.activity, "error");
    assert.equal(store.agentActivities.get("agent-1")?.activity, "error");
    assert.deepEqual(await orchestrator.getActivity("agent-1"), {
      activity: "error",
      activityDetail: "Built-in provider authentication failed",
    });
  } finally {
    orchestrator.shutdown();
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("message received activity does not clear persisted runtime error state", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  seedRuntimeErrorState(orchestrator);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "Message received",
    launchId: "launch-auth",
  });
  await flushMicrotasks();

  assert.deepEqual((orchestrator as any).agentStateCache.get("agent-1").lastRuntimeError, {
    message: "Built-in provider authentication failed",
    at: new Date(0).toISOString(),
    launchId: "launch-auth",
    actionRequired: true,
  });
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "error",
    activityDetail: "Built-in provider authentication failed",
  });

  orchestrator.shutdown();
});

test("runtime progress clears persisted runtime error state", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  seedRuntimeErrorState(orchestrator);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "Applying patch",
    detailKind: "runtime_progress",
    launchId: "launch-auth",
    isHeartbeat: false,
  });
  await flushMicrotasks();

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").lastRuntimeError, null);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "working",
    activityDetail: "Applying patch",
  });

  orchestrator.shutdown();
});

test("same-launch command progress clears persisted runtime error state", async () => {
  const clock = new FakeClock();
  clock.advance(3_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  seedRuntimeErrorState(orchestrator);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "Running command",
    detailKind: "running_command",
    launchId: "launch-auth",
    isHeartbeat: false,
  });
  await flushMicrotasks();

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").lastRuntimeError, null);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "working",
    activityDetail: "Running command",
  });
  assert.equal((orchestrator as any).agentActivity.get("agent-1")?.activity, "working");
  assert.equal((orchestrator as any).agentActivity.get("agent-1")?.detailKind, "running_command");
  assert.equal(orchestrator.emittedActivityPayloads.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 250));
  await flushMicrotasks();
  assert.equal(orchestrator.emittedActivityPayloads.length, 1);
  const emitted = orchestrator.emittedActivityPayloads[0] as Record<string, unknown>;
  assert.equal(emitted.agentId, "agent-1");
  assert.equal(emitted.activity, "working");
  assert.equal(emitted.activityKind, "working");
  assert.equal(emitted.detail, "Running command");
  assert.equal(emitted.detailKind, "running_command");
  assert.equal(emitted.serverSeq, 1);

  orchestrator.shutdown();
});

test("runtime-progress heartbeat cannot clear persisted runtime error state", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  seedRuntimeErrorState(orchestrator);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "Applying patch",
    detailKind: "runtime_progress",
    launchId: "launch-auth",
    isHeartbeat: true,
  });
  await flushMicrotasks();

  assert.deepEqual((orchestrator as any).agentStateCache.get("agent-1").lastRuntimeError, {
    message: "Built-in provider authentication failed",
    at: new Date(0).toISOString(),
    launchId: "launch-auth",
    actionRequired: true,
  });
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "error",
    activityDetail: "Built-in provider authentication failed",
  });

  orchestrator.shutdown();
});

test("untyped display text and trajectory entries cannot clear persisted runtime error state", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  seedRuntimeErrorState(orchestrator);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "Applying patch",
    detailKind: "other",
    launchId: "launch-auth",
    isHeartbeat: false,
    entries: [{ kind: "thinking", text: "working through the change" }],
  });
  await flushMicrotasks();

  assert.deepEqual((orchestrator as any).agentStateCache.get("agent-1").lastRuntimeError, {
    message: "Built-in provider authentication failed",
    at: new Date(0).toISOString(),
    launchId: "launch-auth",
    actionRequired: true,
  });
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "error",
    activityDetail: "Built-in provider authentication failed",
  });

  orchestrator.shutdown();
});

test("unknown activity detailKind fails closed without projection or runtime-error clearing", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  seedRuntimeErrorState(orchestrator);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "Future progress kind",
    detailKind: "future_progress_kind" as any,
    launchId: "launch-auth",
    isHeartbeat: false,
  });
  await flushMicrotasks();

  assert.deepEqual((orchestrator as any).agentStateCache.get("agent-1").lastRuntimeError, {
    message: "Built-in provider authentication failed",
    at: new Date(0).toISOString(),
    launchId: "launch-auth",
    actionRequired: true,
  });
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "error",
    activityDetail: "Built-in provider authentication failed",
  });
  assert.equal((orchestrator as any).agentActivity.get("agent-1")?.detail, "Built-in provider authentication failed");

  orchestrator.shutdown();
});

test("same-launch bookkeeping progress preserves persisted runtime error state", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  seedRuntimeErrorState(orchestrator);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "Restarting runtime",
    launchId: "launch-auth",
  });
  await flushMicrotasks();

  assert.deepEqual((orchestrator as any).agentStateCache.get("agent-1").lastRuntimeError, {
    message: "Built-in provider authentication failed",
    at: new Date(0).toISOString(),
    launchId: "launch-auth",
    actionRequired: true,
  });
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "error",
    activityDetail: "Built-in provider authentication failed",
  });
  assert.equal((orchestrator as any).agentActivity.get("agent-1")?.activity, "error");
  assert.equal((orchestrator as any).agentActivity.get("agent-1")?.detail, "Built-in provider authentication failed");

  orchestrator.shutdown();
});

test("same-launch online activity preserves persisted runtime error state", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  seedRuntimeErrorState(orchestrator);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "online",
    detail: "Idle",
    launchId: "launch-auth",
    entries: [{ kind: "status", activity: "online", detail: "Idle" }],
  });
  await flushMicrotasks();

  assert.deepEqual((orchestrator as any).agentStateCache.get("agent-1").lastRuntimeError, {
    message: "Built-in provider authentication failed",
    at: new Date(0).toISOString(),
    launchId: "launch-auth",
    actionRequired: true,
  });
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "error",
    activityDetail: "Built-in provider authentication failed",
  });
  assert.equal((orchestrator as any).agentActivity.get("agent-1")?.activity, "error");
  assert.equal((orchestrator as any).agentActivity.get("agent-1")?.detail, "Built-in provider authentication failed");

  orchestrator.shutdown();
});

test("successful session clears persisted runtime error state", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  seedRuntimeErrorState(orchestrator);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-ok",
    launchId: "launch-auth",
  });
  await flushMicrotasks();

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").lastRuntimeError, null);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "online",
    activityDetail: "",
  });

  orchestrator.shutdown();
});

test("redis activity does not mask a missing machine replica heartbeat", async () => {
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  await store.setAgentActivity("agent-1", "working", "still-running", "other");
  store.machineReplicas.delete("machine-1");

  const orchestrator = new DeterministicAgentOrchestrator(store);
  seedActiveAgent(orchestrator);

  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "" });

  orchestrator.shutdown();
});

test("stale redis transient activity downgrades to online when the machine is still reachable", async () => {
  const clock = new FakeClock();
  clock.advance(120_000);
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  store.agentActivities.set("agent-1", {
    activity: "working",
    detail: "stuck",
    detailKind: "other",
    observedAtMs: clock.now() - 91_000,
    updatedAt: clock.now(),
  });

  const orchestrator = new DeterministicAgentOrchestrator(store, clock);
  seedActiveAgent(orchestrator);

  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });

  orchestrator.shutdown();
});

test("applyStaleTransientNormalizationAction serves ephemeral online without mutating stale local-cache truth", () => {
  const orchestrator = new StaleTransientApplyDeterministicOrchestrator();
  const now = Date.now();
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "stuck",
    detailKind: "other",
    observedAtMs: now - 95_000,
    updatedAt: now - 91_000,
  });

  assert.deepEqual(
    orchestrator.callApplyStaleTransientNormalizationAction("normalize-online", "agent-1", "local-cache", now),
    { activity: "online", activityDetail: "" },
  );
  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), {
    activity: "working",
    detail: "stuck",
    detailKind: "other",
    observedAtMs: now - 95_000,
    updatedAt: now - 91_000,
  });
  assert.equal((orchestrator as any).activityDebounceTimers.has("agent-1"), false);

  orchestrator.shutdown();
});

test("applyStaleTransientNormalizationAction returns online for stale remote transient hints without mutating local cache", () => {
  const orchestrator = new StaleTransientApplyDeterministicOrchestrator();
  const now = Date.now();
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "cached-local",
    detailKind: "other",
    updatedAt: now - 5_000,
  });

  assert.deepEqual(
    orchestrator.callApplyStaleTransientNormalizationAction("normalize-online", "agent-1", "redis", now),
    { activity: "online", activityDetail: "" },
  );
  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), {
    activity: "working",
    detail: "cached-local",
    detailKind: "other",
    updatedAt: now - 5_000,
  });
  assert.equal((orchestrator as any).activityDebounceTimers.has("agent-1"), false);

  orchestrator.shutdown();
});

test("fresh redis offline state does not mask a recovered online machine", async () => {
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  await store.setAgentActivity("agent-1", "offline", "", "none");

  const orchestrator = new DeterministicAgentOrchestrator(store);
  seedActiveAgent(orchestrator);

  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });

  orchestrator.shutdown();
});

test("applyActivityHintResolutionAction returns remote soft hints without mutating local authority", () => {
  const orchestrator = new ActivityHintApplyDeterministicOrchestrator();
  const snapshot = {
    activity: "working" as const,
    detail: "remote-run",
    detailKind: "other" as const,
    updatedAt: Date.now(),
  };

  const visible = orchestrator.callApplyActivityHintResolutionAction(
    "return-read-through-snapshot",
    "agent-1",
    snapshot,
  );

  assert.deepEqual(visible, {
    activity: "working",
    activityDetail: "remote-run",
  });
  assert.equal((orchestrator as any).agentActivity.get("agent-1"), undefined);
  orchestrator.shutdown();
});

test("applyActivityHintResolutionAction ignores stale or recovered hints without mutating cache", () => {
  const orchestrator = new ActivityHintApplyDeterministicOrchestrator();
  const existing = {
    activity: "online" as const,
    detail: "",
    detailKind: "none" as const,
    updatedAt: Date.now(),
  };
  const snapshot = {
    activity: "offline" as const,
    detail: "",
    detailKind: "none" as const,
    updatedAt: Date.now() - 30_000,
  };
  (orchestrator as any).agentActivity.set("agent-1", existing);

  const visible = orchestrator.callApplyActivityHintResolutionAction(
    "ignore-hint",
    "agent-1",
    snapshot,
  );

  assert.equal(visible, null);
  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), existing);
  orchestrator.shutdown();
});

// --- Server-side stale disconnect guard ---

test("stale machine disconnect (old socket close after reconnect) does not mark agents offline", async () => {
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");

  const orchestrator = new DeterministicAgentOrchestrator(store);
  seedActiveAgent(orchestrator);

  const ws1 = {}; // old socket — replaced by ws2 on reconnect
  const ws2 = {}; // current socket
  seedMachineConnection(orchestrator, "machine-1", ws2);

  // ws1.close fires after ws2 has already taken over — should be silently ignored
  await orchestrator.handleMachineDisconnect("machine-1", ws1 as never);

  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });

  orchestrator.shutdown();
});

test("without stale socket guard, a reconnect+close race would incorrectly mark agents offline", async () => {
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");

  const orchestrator = new BuggyStaleDisconnectOrchestrator(store);
  seedActiveAgent(orchestrator);

  const ws1 = {};
  const ws2 = {};
  seedMachineConnection(orchestrator, "machine-1", ws2);

  // Buggy orchestrator processes the stale ws1 disconnect as if it were legitimate
  await orchestrator.handleMachineDisconnect("machine-1", ws1 as never);

  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "" });

  orchestrator.shutdown();
});

// --- Message deliverability / inbox routing ---

test("cross-replica inbox delivery resolves a pending receive on the owning replica", async () => {
  const network: DeliverabilityNetwork = { owners: new Map([["machine-1", "replica-b"]]), replicas: new Map() };
  const replicaA = new MessageDeliverabilityOrchestrator("replica-a", network);
  const replicaB = new MessageDeliverabilityOrchestrator("replica-b", network);
  const wsB = makeFakeWs(1);

  seedActiveAgent(replicaA);
  seedActiveAgent(replicaB);
  seedMachineConnection(replicaB, "machine-1", wsB);

  const receivePromise = replicaB.receiveMessages("agent-1", true, 10_000);
  await Promise.resolve();

  const message = makeAgentMessage("hello from cross-replica route");
  await replicaA.deliverMessage("agent-1", message);

  const received = await receivePromise;
  assert.deepEqual(received, [message]);
  assert.equal(replicaA.deliveredToMachine.length, 0);
  assert.equal(replicaB.deliveredToMachine.length, 1);
  assert.equal(replicaB.deliveredToMachine[0]?.msg.type, "agent:deliver");

  replicaA.shutdown();
  replicaB.shutdown();
});

test("receipt-required delivery does not upgrade a publish-only cross-replica route to queued", async () => {
  const orchestrator = new PublishOnlyInboxRouteOrchestrator();
  seedActiveAgent(orchestrator);
  const message = makeAgentMessage("publish is not an enqueue receipt");

  // Production routeInboxDelivery currently reports routed even when Redis
  // publish has zero subscribers. This harness preserves that publish-only
  // result so the receipt path must not infer a remote enqueue from it.
  const result = await orchestrator.deliverMessage("agent-1", message, { requireQueueReceipt: true });

  assert.deepEqual(result, { status: "dropped", reason: "cross_replica_receipt_unavailable" });
  assert.equal(orchestrator.publishCalls, 0);
  const inboxes = (orchestrator as unknown as { agentInboxes: Map<string, unknown> }).agentInboxes;
  assert.equal(inboxes.has("agent-1"), false);
  orchestrator.shutdown();
});

test("receipt-required delivery fails closed on an unknown queued receipt", async () => {
  const orchestrator = new MalformedQueuedReceiptOrchestrator();
  seedActiveAgent(orchestrator);

  const result = await orchestrator.deliverMessage(
    "agent-1",
    makeAgentMessage("unknown target queue reason must not become success"),
    { requireQueueReceipt: true },
  );

  assert.deepEqual(result, { status: "dropped", reason: "cross_replica_receipt_unavailable" });
  orchestrator.shutdown();
});

test("receipt-required delivery returns queued only after the remote active owner accepts the inbox", async () => {
  const network: DeliverabilityNetwork = { owners: new Map([["machine-1", "replica-b"]]), replicas: new Map() };
  const source = new EndpointRoutedMessageDeliverabilityOrchestrator("replica-a", network);
  const target = new EndpointRoutedMessageDeliverabilityOrchestrator("replica-b", network);
  seedActiveAgent(source);
  seedActiveAgent(target);
  seedMachineConnection(target, "machine-1", makeFakeWs(1));

  const result = await source.deliverMessage(
    "agent-1",
    makeAgentMessage("strict remote active delivery has a target receipt"),
    { requireQueueReceipt: true },
  );

  assert.deepEqual(result, { status: "queued", reason: "replayable_inbox" });
  const targetInboxes = (target as unknown as { agentInboxes: Map<string, unknown> }).agentInboxes;
  assert.equal((targetInboxes.get("agent-1") as { inbox: unknown[] } | undefined)?.inbox.length, 1);
  source.shutdown();
  target.shutdown();
});

test("receipt-required remote delivery preserves owner/admin authority across replicas", async () => {
  const network: DeliverabilityNetwork = { owners: new Map([["machine-1", "replica-b"]]), replicas: new Map() };
  const source = new ScopeRevokedEndpointRoutedOrchestrator("replica-a", network);
  const target = new ScopeRevokedEndpointRoutedOrchestrator("replica-b", network);
  seedActiveAgent(source);
  seedActiveAgent(target);
  seedMachineConnection(target, "machine-1", makeFakeWs(1));

  const result = await source.deliverMessage(
    "agent-1",
    makeAgentMessage("owner mention keeps its passive-scope authority on the target replica"),
    { requireQueueReceipt: true, adminAuthority: true },
  );

  assert.deepEqual(result, { status: "queued", reason: "replayable_inbox" });
  assert.deepEqual(source.passiveScopeChecks, []);
  assert.deepEqual(target.passiveScopeChecks, []);
  source.shutdown();
  target.shutdown();
});

test("receipt-required remote membership delivery reconciles a queued non-member projection", async () => {
  const network: DeliverabilityNetwork = { owners: new Map([["machine-1", "replica-b"]]), replicas: new Map() };
  const source = new EndpointRoutedMessageDeliverabilityOrchestrator("replica-a", network);
  const target = new EndpointRoutedMessageDeliverabilityOrchestrator("replica-b", network);
  seedActiveAgent(source);
  seedActiveAgent(target);
  seedMachineConnection(target, "machine-1", makeFakeWs(1));

  const notifyOnlyMessage = {
    ...makeAgentMessage("remote membership upgrade"),
    seq: 73,
    message_id: "message-73",
    non_member_mention: true,
  } satisfies AgentMessage;
  target.deliverToLocalInbox("agent-1", notifyOnlyMessage);
  const membershipMessage: AgentMessage = { ...notifyOnlyMessage };
  delete membershipMessage.non_member_mention;

  const result = await source.deliverMessage("agent-1", membershipMessage, {
    requireQueueReceipt: true,
    reconcileNonMemberMention: true,
  });

  assert.deepEqual(result, { status: "queued", reason: "replayable_inbox" });
  const received = await target.receiveMessages("agent-1", false, 0);
  assert.equal(received.length, 1);
  assert.equal(received[0]?.seq, 73);
  assert.equal(received[0]?.non_member_mention, undefined);
  source.shutdown();
  target.shutdown();
});

test("receipt-required delivery stays dropped when a subscribed target replica rejects the enqueue", async () => {
  const cases = ["inactive", "access-revoked"] as const;

  for (const scenario of cases) {
    const network: DeliverabilityNetwork = { owners: new Map([["machine-1", "replica-b"]]), replicas: new Map() };
    const source = new EndpointRoutedMessageDeliverabilityOrchestrator("replica-a", network);
    const target = scenario === "inactive"
      ? new EndpointRoutedMessageDeliverabilityOrchestrator("replica-b", network)
      : new AccessRevokedEndpointRoutedOrchestrator("replica-b", network);
    seedActiveAgent(source);
    seedActiveAgent(target);
    if (scenario === "inactive") {
      const cache = (target as unknown as {
        agentStateCache: Map<string, { status: string }>;
      }).agentStateCache;
      const agent = cache.get("agent-1");
      assert.ok(agent);
      agent.status = "inactive";
    }

    const result = await source.deliverMessage(
      "agent-1",
      makeAgentMessage(`target rejects after publish: ${scenario}`),
      { requireQueueReceipt: true },
    );

    assert.deepEqual(result, { status: "dropped", reason: "cross_replica_receipt_unavailable" });
    const targetInboxes = (target as unknown as { agentInboxes: Map<string, unknown> }).agentInboxes;
    assert.equal(targetInboxes.has("agent-1"), false);
    source.shutdown();
    target.shutdown();
  }
});

test("receipt-required inactive wake returns queued only after the remote daemon accepts the start", async () => {
  const network: DeliverabilityNetwork = { owners: new Map([["machine-1", "replica-b"]]), replicas: new Map() };
  const source = new EndpointRoutedMessageDeliverabilityOrchestrator("replica-a", network);
  const target = new EndpointRoutedMessageDeliverabilityOrchestrator("replica-b", network);
  const targetWs = makeFakeWs(1);
  seedActiveAgent(source);
  seedActiveAgent(target);
  seedMachineConnection(target, "machine-1", targetWs);
  const sourceCache = (source as unknown as {
    agentStateCache: Map<string, { status: string }>;
  }).agentStateCache;
  const sourceAgent = sourceCache.get("agent-1");
  assert.ok(sourceAgent);
  sourceAgent.status = "inactive";
  const targetCache = (target as unknown as {
    agentStateCache: Map<string, { status: string }>;
  }).agentStateCache;
  const targetAgent = targetCache.get("agent-1");
  assert.ok(targetAgent);
  targetAgent.status = "inactive";

  const result = await source.deliverMessage(
    "agent-1",
    makeAgentMessage("remote start has a target acceptance receipt"),
    { requireQueueReceipt: true },
  );

  assert.deepEqual(result, { status: "queued", reason: "wake_accepted" });
  assert.equal(targetWs.sent.length, 1);
  assert.equal(JSON.parse(targetWs.sent[0]!).type, "agent:start");
  assert.equal(sourceCache.get("agent-1")?.status, "inactive");
  source.shutdown();
  target.shutdown();
});

test("routed deliver command wakes an inactive current owner with the first message", async () => {
  const network: DeliverabilityNetwork = { owners: new Map([["machine-1", "replica-b"]]), replicas: new Map() };
  const staleReplica = new EndpointRoutedMessageDeliverabilityOrchestrator("replica-a", network);
  const currentOwner = new EndpointRoutedMessageDeliverabilityOrchestrator("replica-b", network);
  const wsB = makeFakeWs(1);

  seedActiveAgent(staleReplica, "agent-1", "machine-1");
  seedActiveAgent(currentOwner, "agent-1", "machine-1");
  (currentOwner as any).agentStateCache.get("agent-1").status = "inactive";
  seedMachineConnection(currentOwner, "machine-1", wsB);

  const message = makeAgentMessage("first mention after reconnect", 7);
  await staleReplica.deliverMessage("agent-1", message);
  await waitForCondition(() => wsB.sent.length === 1);

  const sent = wsB.sent.map((raw: string) => JSON.parse(raw));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "agent:start");
  assert.deepEqual(sent[0].wakeMessage, message);
  assert.equal((currentOwner as any).agentInboxes.get("agent-1")?.inbox.length ?? 0, 0);

  staleReplica.shutdown();
  currentOwner.shutdown();
});

test("stale closed local machine entry does not block delivery to the real remote owner", async () => {
  const network: DeliverabilityNetwork = { owners: new Map([["machine-1", "replica-b"]]), replicas: new Map() };
  const replicaA = new MessageDeliverabilityOrchestrator("replica-a", network);
  const replicaB = new MessageDeliverabilityOrchestrator("replica-b", network);
  const staleWsA = makeFakeWs(3);
  const wsB = makeFakeWs(1);

  seedActiveAgent(replicaA);
  seedActiveAgent(replicaB);
  seedMachineConnection(replicaA, "machine-1", staleWsA);
  seedMachineConnection(replicaB, "machine-1", wsB);

  const receivePromise = replicaB.receiveMessages("agent-1", true, 10_000);
  await Promise.resolve();

  const message = makeAgentMessage("deliver after remap");
  await replicaA.deliverMessage("agent-1", message);

  const received = await receivePromise;
  assert.deepEqual(received, [message]);
  assert.equal((replicaA as any).agentInboxes.get("agent-1")?.inbox.length ?? 0, 0);
  assert.equal(replicaB.deliveredToMachine.length, 1);

  replicaA.shutdown();
  replicaB.shutdown();
});

test("buggy stale-local ownership semantics would strand the message on the wrong replica", async () => {
  const network: DeliverabilityNetwork = { owners: new Map([["machine-1", "replica-b"]]), replicas: new Map() };
  const replicaA = new BuggyStaleLocalMessageRoutingOrchestrator("replica-a", network);
  const replicaB = new BuggyStaleLocalMessageRoutingOrchestrator("replica-b", network);
  const staleWsA = makeFakeWs(3);
  const wsB = makeFakeWs(1);

  seedActiveAgent(replicaA);
  seedActiveAgent(replicaB);
  seedMachineConnection(replicaA, "machine-1", staleWsA);
  seedMachineConnection(replicaB, "machine-1", wsB);

  const message = makeAgentMessage("stranded by stale local owner");
  await replicaA.deliverMessage("agent-1", message);

  assert.equal((replicaA as any).agentInboxes.get("agent-1")?.inbox.length ?? 0, 1);
  assert.equal((replicaB as any).agentInboxes.get("agent-1")?.inbox.length ?? 0, 0);
  assert.equal(replicaB.deliveredToMachine.length, 0);

  replicaA.shutdown();
  replicaB.shutdown();
});

// --- Cross-replica routing failover after machine remap ---

test("stale routed machine command is re-routed to the new owner after remap", async () => {
  const network: DeliverabilityNetwork = { owners: new Map([["machine-1", "replica-b"]]), replicas: new Map() };
  const oldOwner = new MessageDeliverabilityOrchestrator("replica-a", network);
  const newOwner = new MessageDeliverabilityOrchestrator("replica-b", network);
  const wsB = makeFakeWs(1);

  seedMachineConnection(newOwner, "machine-1", wsB);

  const delivered = await oldOwner.handleRoutedMachineCommand("machine-1", {
    type: "agent:deliver",
    agentId: "agent-1",
    message: makeAgentMessage("rerouted machine command"),
    seq: 1,
  });

  assert.equal(delivered, true);
  assert.equal(newOwner.deliveredToMachine.length, 1);
  assert.equal(newOwner.deliveredToMachine[0]?.machineId, "machine-1");

  oldOwner.shutdown();
  newOwner.shutdown();
});

test("applyRoutedOwnershipAction short-circuits after a successful reroute", async () => {
  const orchestrator = new RoutedOwnershipApplyDeterministicOrchestrator();

  const delivered = await orchestrator.callApplyRoutedOwnershipAction("reroute-then-fallback", true);

  assert.equal(delivered, true);
  assert.deepEqual(orchestrator.calls, ["reroute"]);
  orchestrator.shutdown();
});

test("applyRoutedOwnershipAction falls back when reroute does not succeed", async () => {
  const orchestrator = new RoutedOwnershipApplyDeterministicOrchestrator();

  const delivered = await orchestrator.callApplyRoutedOwnershipAction("reroute-then-fallback", false);

  assert.equal(delivered, false);
  assert.deepEqual(orchestrator.calls, ["reroute", "fallback"]);
  orchestrator.shutdown();
});

test("buggy stale routed machine command semantics would silently drop delivery after remap", async () => {
  const network: DeliverabilityNetwork = { owners: new Map([["machine-1", "replica-b"]]), replicas: new Map() };
  const oldOwner = new BuggyRoutedMachineCommandOrchestrator("replica-a", network);
  const newOwner = new BuggyRoutedMachineCommandOrchestrator("replica-b", network);
  const wsB = makeFakeWs(1);

  seedMachineConnection(newOwner, "machine-1", wsB);

  const delivered = await oldOwner.handleRoutedMachineCommand("machine-1", {
    type: "agent:deliver",
    agentId: "agent-1",
    message: makeAgentMessage("dropped after remap"),
    seq: 1,
  });

  assert.equal(delivered, false);
  assert.equal(newOwner.deliveredToMachine.length, 0);

  oldOwner.shutdown();
  newOwner.shutdown();
});

test("stale routed inbox delivery is re-routed to the new owner after remap", async () => {
  const network: DeliverabilityNetwork = { owners: new Map([["machine-1", "replica-b"]]), replicas: new Map() };
  const oldOwner = new MessageDeliverabilityOrchestrator("replica-a", network);
  const newOwner = new MessageDeliverabilityOrchestrator("replica-b", network);
  const message = makeAgentMessage("rerouted inbox delivery");

  seedActiveAgent(oldOwner);
  seedActiveAgent(newOwner);

  const receivePromise = newOwner.receiveMessages("agent-1", true, 10_000);
  await Promise.resolve();

  const delivered = await oldOwner.handleRoutedInboxDelivery("agent-1", "machine-1", message);

  assert.equal(delivered, true);
  assert.deepEqual(await receivePromise, [message]);
  assert.equal((oldOwner as any).agentInboxes.get("agent-1")?.inbox.length ?? 0, 0);

  oldOwner.shutdown();
  newOwner.shutdown();
});

test("buggy stale routed inbox semantics would strand the message on the old owner after remap", async () => {
  const network: DeliverabilityNetwork = { owners: new Map([["machine-1", "replica-b"]]), replicas: new Map() };
  const oldOwner = new BuggyRoutedInboxDeliveryOrchestrator("replica-a", network);
  const newOwner = new BuggyRoutedInboxDeliveryOrchestrator("replica-b", network);
  const message = makeAgentMessage("stale inbox on old owner");

  seedActiveAgent(oldOwner);
  seedActiveAgent(newOwner);

  const delivered = await oldOwner.handleRoutedInboxDelivery("agent-1", "machine-1", message);

  assert.equal(delivered, true);
  assert.equal((oldOwner as any).agentInboxes.get("agent-1")?.inbox.length ?? 0, 1);
  assert.equal((newOwner as any).agentInboxes.get("agent-1")?.inbox.length ?? 0, 0);

  oldOwner.shutdown();
  newOwner.shutdown();
});

test("routed inbox delivery revalidates against current cached ownership instead of a stale payload machineId", async () => {
  const network: DeliverabilityNetwork = { owners: new Map([["machine-2", "replica-b"]]), replicas: new Map() };
  const oldOwner = new MessageDeliverabilityOrchestrator("replica-a", network);
  const newOwner = new MessageDeliverabilityOrchestrator("replica-b", network);
  const message = makeAgentMessage("rerouted using current ownership");

  seedActiveAgent(oldOwner, "agent-1", "machine-2");
  seedActiveAgent(newOwner, "agent-1", "machine-2");

  const receivePromise = newOwner.receiveMessages("agent-1", true, 10_000);
  await Promise.resolve();

  const delivered = await oldOwner.handleRoutedInboxDelivery("agent-1", "machine-1", message);

  assert.equal(delivered, true);
  assert.deepEqual(await receivePromise, [message]);
  assert.equal((oldOwner as any).agentInboxes.get("agent-1")?.inbox.length ?? 0, 0);

  oldOwner.shutdown();
  newOwner.shutdown();
});

test("routed inbox delivery without payload machineId still revalidates current ownership for mixed-version compatibility", async () => {
  const network: DeliverabilityNetwork = { owners: new Map([["machine-1", "replica-b"]]), replicas: new Map() };
  const oldOwner = new MessageDeliverabilityOrchestrator("replica-a", network);
  const newOwner = new MessageDeliverabilityOrchestrator("replica-b", network);
  const message = makeAgentMessage("rerouted without payload machine hint");

  seedActiveAgent(oldOwner);
  seedActiveAgent(newOwner);

  const receivePromise = newOwner.receiveMessages("agent-1", true, 10_000);
  await Promise.resolve();

  const delivered = await oldOwner.handleRoutedInboxDelivery("agent-1", null, message);

  assert.equal(delivered, true);
  assert.deepEqual(await receivePromise, [message]);
  assert.equal((oldOwner as any).agentInboxes.get("agent-1")?.inbox.length ?? 0, 0);

  oldOwner.shutdown();
  newOwner.shutdown();
});

test("buggy payload-anchored routed inbox semantics would strand delivery on stale ownership hints", async () => {
  const network: DeliverabilityNetwork = { owners: new Map([["machine-2", "replica-b"]]), replicas: new Map() };
  const oldOwner = new BuggyPayloadAnchoredRoutedInboxOrchestrator("replica-a", network);
  const newOwner = new BuggyPayloadAnchoredRoutedInboxOrchestrator("replica-b", network);
  const message = makeAgentMessage("stale machine hint strands delivery");

  seedActiveAgent(oldOwner, "agent-1", "machine-2");
  seedActiveAgent(newOwner, "agent-1", "machine-2");

  const delivered = await oldOwner.handleRoutedInboxDelivery("agent-1", "machine-1", message);

  assert.equal(delivered, true);
  assert.equal((oldOwner as any).agentInboxes.get("agent-1")?.inbox.length ?? 0, 1);
  assert.equal((newOwner as any).agentInboxes.get("agent-1")?.inbox.length ?? 0, 0);

  oldOwner.shutdown();
  newOwner.shutdown();
});

test("late routed inbox delivery is dropped after the agent has already gone inactive", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  const message = makeAgentMessage("late message after stop");

  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  (orchestrator as any).agentStateCache.get("agent-1").status = "inactive";

  const delivered = await orchestrator.handleRoutedInboxDelivery("agent-1", "machine-1", message);

  assert.equal(delivered, true);
  assert.equal((orchestrator as any).agentInboxes.has("agent-1"), false);
  orchestrator.shutdown();
});

test("applyLocalDeliveryGateAction delivers locally when the gate says deliver-locally", () => {
  const orchestrator = new LocalDeliveryGateApplyDeterministicOrchestrator();
  const message = makeAgentMessage("deliver now");

  const delivered = orchestrator.callApplyLocalDeliveryGateAction("deliver-locally", "agent-1", message);

  assert.equal(delivered, true);
  assert.deepEqual((orchestrator as any).agentInboxes.get("agent-1")?.inbox ?? [], [message]);
  orchestrator.shutdown();
});

test("applyLocalDeliveryGateAction drops without creating an inbox when the gate says drop-delivery", () => {
  const orchestrator = new LocalDeliveryGateApplyDeterministicOrchestrator();
  const message = makeAgentMessage("drop now");

  const delivered = orchestrator.callApplyLocalDeliveryGateAction("drop-delivery", "agent-1", message);

  assert.equal(delivered, true);
  assert.equal((orchestrator as any).agentInboxes.has("agent-1"), false);
  orchestrator.shutdown();
});

test("buggy late routed inbox semantics recreate a local inbox even after the agent is inactive", async () => {
  const network: DeliverabilityNetwork = { owners: new Map(), replicas: new Map() };
  const orchestrator = new BuggyRoutedInboxDeliveryOrchestrator("replica-a", network);
  const message = makeAgentMessage("late message after stop");

  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  (orchestrator as any).agentStateCache.get("agent-1").status = "inactive";

  const delivered = await orchestrator.handleRoutedInboxDelivery("agent-1", "machine-1", message);

  assert.equal(delivered, true);
  assert.equal((orchestrator as any).agentInboxes.get("agent-1")?.inbox.length ?? 0, 1);
  orchestrator.shutdown();
});

test("deliverMessage wakes an inactive agent with the current user message", async () => {
  const orchestrator = new InactiveWindowDeliverMessageOrchestrator();
  const message = makeAgentMessage("message during reset window");

  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  (orchestrator as any).agentStateCache.get("agent-1").status = "inactive";

  const result = await orchestrator.deliverMessage("agent-1", message);

  assert.deepEqual(result, { status: "queued", reason: "wake_accepted" });
  assert.equal(orchestrator.sentToMachine.length, 1);
  const startMsg = orchestrator.sentToMachine[0];
  assert.ok(startMsg && startMsg.type === "agent:start");
  assert.deepEqual(startMsg, {
    type: "agent:start",
    agentId: "agent-1",
    config: {
      name: "agent-1",
      displayName: null,
      description: null,
      model: "gpt-5",
      runtime: "codex",
      runtimeConfig: {
        version: 1,
        runtime: "codex",
        model: { kind: "preset", id: "gpt-5" },
        mode: { kind: "default" },
        reasoningEffort: null,
        envVars: null,
      },
      reasoningEffort: null,
      executionMode: "cloud",
      envVars: null,
      sessionId: null,
      serverUrl: "http://localhost:3001",
      authToken: "",
      runtimeContext: {
        agentId: "agent-1",
        serverId: "server-1",
        machineId: "machine-1",
        machineName: null,
        machineDescription: null,
        machineHostname: null,
        machineOs: null,
        daemonVersion: null,
        workspacePath: null,
      },
    },
    wakeMessage: message,
    wakeMessageTransient: false,
    unreadSummary: undefined,
    resumePrompt: undefined,
    launchId: startMsg.launchId,
    startDispatchId: startMsg.startDispatchId,
    traceparent: startMsg.traceparent,
  });
  assert.deepEqual(recentLifecycleEvents(orchestrator), [
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "wake",
      outcome: "attempted",
      cause: "message",
      previousStatus: "inactive",
    },
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "start",
      outcome: "completed",
      cause: "message",
      previousStatus: "inactive",
      nextStatus: "active",
    },
  ]);
  orchestrator.shutdown();
});

test("receipt-required delivery accepts an inactive wake dispatched to the local machine", async () => {
  const orchestrator = new InactiveWindowDeliverMessageOrchestrator();
  const message = makeAgentMessage("local wake receipt");

  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  (orchestrator as unknown as {
    agentStateCache: Map<string, { status: string }>;
  }).agentStateCache.get("agent-1")!.status = "inactive";

  const result = await orchestrator.deliverMessage("agent-1", message, { requireQueueReceipt: true });

  assert.deepEqual(result, { status: "queued", reason: "wake_accepted" });
  assert.equal(orchestrator.sentToMachine.length, 1);
  assert.equal(orchestrator.sentToMachine[0]?.type, "agent:start");
  orchestrator.shutdown();
});

test("deliverMessage records wake failure when waking an inactive agent fails", async () => {
  const orchestrator = new FailingWakeDeliverMessageOrchestrator();
  const message = makeAgentMessage("message during failed wake");

  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  (orchestrator as any).agentStateCache.get("agent-1").status = "inactive";

  const result = await orchestrator.deliverMessage("agent-1", message);

  assert.deepEqual(result, { status: "dropped", reason: "wake_failed" });
  assert.deepEqual(orchestrator.sentToMachine.map((msg) => msg.type), ["agent:start"]);
  assert.deepEqual(recentLifecycleEvents(orchestrator), [
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "wake",
      outcome: "attempted",
      cause: "message",
      previousStatus: "inactive",
    },
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "start",
      outcome: "failed",
      cause: "message",
      previousStatus: "inactive",
      detail: "Machine offline. Please start your local daemon.",
    },
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "wake",
      outcome: "failed",
      cause: "message",
      previousStatus: "inactive",
      detail: "Machine offline. Please start your local daemon.",
    },
  ]);
  orchestrator.shutdown();
});

test("lifecycle events use the injected clock and stay time-ordered", async () => {
  const clock = new FakeClock();
  const orchestrator = new InactiveWindowDeliverMessageOrchestrator(new InMemoryReplicaStateStore(), clock);
  const message = makeAgentMessage("message after manual stop");

  seedActiveAgent(orchestrator, "agent-1", "machine-1");

  clock.advance(10);
  await orchestrator.stopAgent("agent-1");
  clock.advance(15);
  await orchestrator.deliverMessage("agent-1", message);

  assert.deepEqual(
    recentLifecycleEventsWithTimestamps(orchestrator).map(({ at, action, outcome }) => ({ at, action, outcome })),
    [
      { at: 10, action: "stop", outcome: "completed" },
      { at: 25, action: "wake", outcome: "suppressed" },
    ],
  );
  orchestrator.shutdown();
});

test("manual stop moves the agent to stopped and new messages do not auto-wake it", async () => {
  const orchestrator = new InactiveWindowDeliverMessageOrchestrator();
  const message = makeAgentMessage("message after manual stop");

  seedActiveAgent(orchestrator, "agent-1", "machine-1");

  await orchestrator.stopAgent("agent-1");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "stopped");
  assert.equal(orchestrator.sentToMachine.length, 1);
  assert.equal(orchestrator.sentToMachine[0]?.type, "agent:stop");

  await orchestrator.deliverMessage("agent-1", message);

  assert.equal(orchestrator.sentToMachine.length, 1);
  assert.equal((orchestrator as any).agentInboxes.has("agent-1"), false);
  assert.deepEqual(recentLifecycleEvents(orchestrator), [
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "stop",
      outcome: "completed",
      cause: "manual",
      previousStatus: "active",
      nextStatus: "stopped",
    },
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "wake",
      outcome: "suppressed",
      cause: "message",
      previousStatus: "stopped",
    },
  ]);
  orchestrator.shutdown();
});

test("manual stop lifecycle span records the visible offline activity transition", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new StopApplyDeterministicOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.callApplyStopAction("agent-1", "manual");

  const stopSpan = sink.getTrace(traceId).find((span) => span.name === "server.agent.lifecycle.stop.apply");
  assert.ok(stopSpan);
  assert.equal(stopSpan.attrs?.reason, "manual");
  assert.equal(stopSpan.attrs?.previous_status, "active");
  assert.equal(stopSpan.attrs?.next_status, "stopped");
  assert.equal(stopSpan.attrs?.outcome, "applied");
  assert.equal(stopSpan.attrs?.live_activity_updated, true);
  assert.equal(stopSpan.attrs?.previous_activity_status, "none");
  assert.equal(stopSpan.attrs?.next_activity_status, "offline");
  assert.equal(stopSpan.attrs?.activity_status, "offline");
  assert.equal(stopSpan.attrs?.activity_transition, "none->offline");
  const stopFact = traceSpanFactRowForSpanName(sink, traceId, "server.agent.lifecycle.stop.apply");
  assert.equal(stopFact.agent_id, "agent-1");
  assert.equal(stopFact.machine_id, "machine-1");
  assert.equal(stopFact.server_id, "server-1");
  assert.equal(stopFact.event_kind, "stop_requested");
  assert.equal(stopFact.source, "server_control");
  assert.equal(stopFact.authority, "server_control");
  assert.equal(stopFact.outcome, "applied");
  assert.equal(stopFact.reason, "manual");
  orchestrator.shutdown();
});

test("internal stop/start lifecycle spans distinguish status churn from activity transition", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new StopApplyDeterministicOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.callApplyStopAction("agent-1", "internal");
  await orchestrator.startAgent("agent-1");

  const stopSpan = sink.getTrace(traceId).find((span) => span.name === "server.agent.lifecycle.stop.apply");
  assert.ok(stopSpan);
  assert.equal(stopSpan.attrs?.reason, "internal");
  assert.equal(stopSpan.attrs?.previous_status, "active");
  assert.equal(stopSpan.attrs?.next_status, "inactive");
  assert.equal(stopSpan.attrs?.outcome, "applied");
  assert.equal(stopSpan.attrs?.live_activity_updated, false);

  const startSpan = sink.getTrace(traceId).find((span) => span.name === "server.agent.lifecycle.start.apply");
  assert.ok(startSpan);
  assert.equal(startSpan.attrs?.previous_status, "inactive");
  assert.equal(startSpan.attrs?.start_cause, "manual");
  assert.equal(startSpan.attrs?.outcome, "applied");
  assert.equal(startSpan.attrs?.live_activity_updated, true);
  assert.equal(startSpan.attrs?.previous_activity_status, "none");
  assert.equal(startSpan.attrs?.next_activity_status, "working");
  assert.equal(startSpan.attrs?.activity_status, "working");
  assert.equal(startSpan.attrs?.activity_transition, "none->working");
  const startFact = traceSpanFactRowForSpanName(sink, traceId, "server.agent.lifecycle.start.apply");
  assert.equal(startFact.agent_id, "agent-1");
  assert.equal(startFact.machine_id, "machine-1");
  assert.equal(startFact.server_id, "server-1");
  assert.equal(startFact.event_kind, "start_requested");
  assert.equal(startFact.source, "server_control");
  assert.equal(startFact.authority, "server_control");
  assert.equal(startFact.outcome, "applied");
  assert.equal(startFact.reason, "manual_start");
  orchestrator.shutdown();
});

test("persisted stopped suppresses lazy wake when replica cache is stale inactive", async () => {
  const orchestrator = new StaleCachedStoppedDeliveryOrchestrator("stopped");
  const message = makeAgentMessage("message after stopped on another replica");

  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  (orchestrator as any).agentStateCache.get("agent-1").status = "inactive";

  await orchestrator.deliverMessage("agent-1", message);

  assert.equal(orchestrator.sentToMachine.length, 0);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "stopped");
  assert.equal((orchestrator as any).agentInboxes.has("agent-1"), false);
  assert.deepEqual(recentLifecycleEvents(orchestrator), [
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "wake",
      outcome: "suppressed",
      cause: "message",
      previousStatus: "stopped",
    },
  ]);
  orchestrator.shutdown();
});

test("persisted stopped suppresses direct delivery when replica cache is stale active", async () => {
  const orchestrator = new StaleCachedStoppedDeliveryOrchestrator("stopped");
  const message = makeAgentMessage("message after stopped but stale active locally");

  seedActiveAgent(orchestrator, "agent-1", "machine-1");

  await orchestrator.deliverMessage("agent-1", message);

  assert.equal(orchestrator.sentToMachine.length, 0);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "stopped");
  assert.equal((orchestrator as any).agentInboxes.has("agent-1"), false);
  assert.deepEqual(recentLifecycleEvents(orchestrator), [
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "wake",
      outcome: "suppressed",
      cause: "message",
      previousStatus: "stopped",
    },
  ]);
  orchestrator.shutdown();
});

test("stop apply manual immediately surfaces stopped activity when daemon is reachable", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new StopApplyDeterministicOrchestrator(store, undefined, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.startAgent("agent-1");
  assert.equal(store.wakeLocks.size, 1);
  orchestrator.sentToMachine.length = 0;

  await orchestrator.callApplyStopAction("agent-1", "manual");

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "stopped");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "Stopped" });
  assertResolveSpanAgentIdentity(sink, traceId, "agent-1", "stopped-status");
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "stale pre-stop activity",
    updatedAt: Date.now(),
  });
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "Stopped" });
  assert.equal(store.wakeLocks.size, 0);
  assert.deepEqual(
    orchestrator.sentToMachine.map((msg) => msg.type),
    ["agent:stop"],
  );
  assert.deepEqual(recentLifecycleEvents(orchestrator), [
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "start",
      outcome: "completed",
      cause: "manual",
      previousStatus: "active",
      nextStatus: "active",
    },
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "stop",
      outcome: "completed",
      cause: "manual",
      previousStatus: "active",
      nextStatus: "stopped",
    },
  ]);
  orchestrator.shutdown();
});

test("stop apply internal persists inactive without overwriting pre-stop activity when daemon is reachable", async () => {
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new StopApplyDeterministicOrchestrator(store);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.startAgent("agent-1");
  assert.equal(store.wakeLocks.size, 1);
  orchestrator.sentToMachine.length = 0;

  await orchestrator.callApplyStopAction("agent-1", "internal");

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "inactive");
  // Reachable-daemon stops are daemon-owned for visible activity. Until the
  // daemon ack arrives, the previous visible activity should remain unchanged.
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "working", activityDetail: "Starting…" });
  assert.equal(store.wakeLocks.size, 0);
  assert.deepEqual(
    orchestrator.sentToMachine.map((msg) => msg.type),
    ["agent:stop"],
  );
  assert.deepEqual(recentLifecycleEvents(orchestrator), [
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "start",
      outcome: "completed",
      cause: "manual",
      previousStatus: "active",
      nextStatus: "active",
    },
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "stop",
      outcome: "completed",
      cause: "internal",
      previousStatus: "active",
      nextStatus: "inactive",
    },
  ]);
  orchestrator.shutdown();
});

test("manual stop clears persisted runtime error state", async () => {
  const orchestrator = new StopApplyDeterministicOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  seedRuntimeErrorState(orchestrator);

  await orchestrator.callApplyStopAction("agent-1", "manual");

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").lastRuntimeError, null);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "Stopped" });
  orchestrator.shutdown();
});

test("internal stop preserves persisted runtime error state", async () => {
  const orchestrator = new StopApplyDeterministicOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  seedRuntimeErrorState(orchestrator);

  await orchestrator.callApplyStopAction("agent-1", "internal");

  assert.deepEqual((orchestrator as any).agentStateCache.get("agent-1").lastRuntimeError, {
    message: "Built-in provider authentication failed",
    at: new Date(0).toISOString(),
    launchId: "launch-auth",
    actionRequired: true,
  });
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "error",
    activityDetail: "Built-in provider authentication failed",
  });
  orchestrator.shutdown();
});

test("stop apply emits server-side stopped fallback when machine stop is unreachable", async () => {
  const orchestrator = new UnreachableStopApplyDeterministicOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");

  await orchestrator.callApplyStopAction("agent-1", "manual");

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "stopped");
  const fallbackActivity = (orchestrator as any).agentActivity.get("agent-1");
  assert.equal(fallbackActivity.activity, "offline");
  assert.equal(fallbackActivity.detail, "Agent stopped by user");
  assert.equal(typeof fallbackActivity.updatedAt, "number");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "Stopped" });
  assert.deepEqual(
    orchestrator.sentToMachine.map((msg) => msg.type),
    ["agent:stop"],
  );
  orchestrator.shutdown();
});

test("ready reconciliation does not resurrect a manually stopped agent that the daemon still reports as running", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new ReadyReconcileDeterministicOrchestrator(undefined, undefined, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.stopAgent("agent-1");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "stopped");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "Stopped" });

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [],
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: ["agent-1"],
  } as MachineToServerMessage);

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "stopped");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "Stopped" });
  assert.deepEqual(
    orchestrator.sentToMachine.map((msg) => msg.type),
    ["agent:stop", "agent:stop"],
  );
  const readySpan = sink.getTrace(traceId).find((span) => span.name === "server.machine.ready.reconcile");
  assert.ok(readySpan);
  assert.equal(readySpan.attrs?.machine_id_present, true);
  assert.equal(readySpan.attrs?.running_agents_count, 1);
  assert.equal(readySpan.attrs?.runtimes_count, 1);
  assert.equal(readySpan.attrs?.outcome, "processed");
  assert.equal(readySpan.attrs?.force_stop_and_stay_offline_count, 1);
  assert.equal(eventsForSpan(sink, traceId, "server.machine.ready.reconcile").some((event) => event.name === "machine.ready.agents.loaded"), true);
  const [readyLoadedRow] = traceEventRowsForSpanName(sink, traceId, "server.machine.ready.reconcile")
    .filter((row) => row.event_name === "machine.ready.agents.loaded");
  assert.ok(readyLoadedRow);
  assert.equal(readyLoadedRow.machine_id, "machine-1");
  assert.equal(readyLoadedRow.server_id, "server-1");
  assert.equal(readyLoadedRow.agent_id, null);
  assert.equal(readyLoadedRow.outcome, "loaded");
  orchestrator.shutdown();
});

test("a runtime we failed to record is not announced: no capabilities broadcast when the write fails", async () => {
  // `machines.runtimes` IS the fact the setup projection reads (single cross-replica source).
  // A swallowed write failure followed by a cheerful broadcast is how you get a client saying
  // "runtime detected" while the projection still sees NULL and Next stays dead, with nothing
  // on screen to explain it. Someone can retry a silence; they cannot argue with a lie.
  // (@Jianwei's forced-throw tooth, 2026-07-13.)
  const orchestrator = new CapabilitiesPersistFailsOrchestrator();
  const captured: Array<{ room: string; event: string; payload: unknown }> = [];
  (orchestrator as unknown as { io: ReturnType<typeof makeFakeServerIO> }).io = makeFakeServerIO(captured);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [],
    runtimes: ["codex"],
    daemonVersion: "0.55.6",
    runningAgents: [],
  } as MachineToServerMessage);

  assert.equal(
    captured.find((entry) => entry.event === "machine:capabilities"),
    undefined,
    "the client must not be told a runtime is ready when the only record of it failed to write",
  );
  orchestrator.shutdown();
});

test("ready reconciliation broadcasts computerVersion with machine capabilities", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new ReadyReconcileDeterministicOrchestrator(undefined, undefined, tracer);
  const captured: Array<{ room: string; event: string; payload: unknown }> = [];
  (orchestrator as unknown as { io: ReturnType<typeof makeFakeServerIO> }).io = makeFakeServerIO(captured);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [],
    runtimes: ["codex"],
    runtimeVersions: { codex: " 0.75.1 ", claude: "must-be-filtered" },
    daemonVersion: "0.55.6",
    computerVersion: "0.0.25",
    runningAgents: [],
  } as MachineToServerMessage);

  assert.deepEqual(captured.find((entry) => entry.event === "machine:capabilities"), {
    room: "server:server-1",
    event: "machine:capabilities",
    payload: {
      machineId: "machine-1",
      runtimes: ["codex"],
      runtimeVersions: { codex: "0.75.1" },
      hostname: undefined,
      os: undefined,
      daemonVersion: "0.55.6",
      computerVersion: "0.0.25",
    },
  });
  assert.deepEqual(
    (await buildMachineReadModel(makeMachineRecord(), orchestrator)).runtimeVersions,
    { codex: "0.75.1" },
    "the owner-replica read model exposes the normalized live runtime versions",
  );
  const readySpan = sink.getTrace(traceId).find((span) => span.name === "server.machine.ready.reconcile");
  assert.ok(readySpan);
  assert.equal(readySpan.attrs?.daemonVersion, "0.55.6");
  assert.equal(readySpan.attrs?.daemon_version, "0.55.6");
  assert.equal(readySpan.attrs?.daemon_version_present, true);
  assert.equal(readySpan.attrs?.computerVersion, "0.0.25");
  assert.equal(readySpan.attrs?.computer_version, "0.0.25");
  assert.equal(readySpan.attrs?.computer_version_present, true);
  orchestrator.shutdown();
});

test("ready from an older daemon clears stale runtime versions", async () => {
  const orchestrator = new ReadyReconcileDeterministicOrchestrator();
  const captured: Array<{ room: string; event: string; payload: unknown }> = [];
  (orchestrator as unknown as { io: ReturnType<typeof makeFakeServerIO> }).io = makeFakeServerIO(captured);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [],
    runtimes: ["codex"],
    daemonVersion: "0.55.6",
    runningAgents: [],
  } as MachineToServerMessage);

  assert.deepEqual(captured.find((entry) => entry.event === "machine:capabilities"), {
    room: "server:server-1",
    event: "machine:capabilities",
    payload: {
      machineId: "machine-1",
      runtimes: ["codex"],
      runtimeVersions: {},
      hostname: undefined,
      os: undefined,
      daemonVersion: "0.55.6",
      computerVersion: undefined,
    },
  });
  assert.deepEqual(
    (await buildMachineReadModel(makeMachineRecord(), orchestrator)).runtimeVersions,
    {},
    "a missing version map must not retain a prior daemon's values",
  );
  orchestrator.shutdown();
});

test("user-visible machine read model recovers runtime versions from replica metadata", async () => {
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  await store.setMachineMeta("machine-1", {
    runtimeVersions: JSON.stringify({ codex: "0.75.1", claude: "1.2.3" }),
  });
  const reader = new DeterministicAgentOrchestrator(store);

  const machine = await buildMachineReadModel(makeMachineRecord(), reader);

  assert.deepEqual(machine.runtimeVersions, { codex: "0.75.1", claude: "1.2.3" });
  reader.shutdown();
});

test("relays computer restart/upgrade terminal receipts to web with machineId added", async () => {
  // The daemon frame carries only requestId (it doesn't know its own
  // server-machine id); the server adds machineId before relaying to the
  // server room so the web (machineStore) can route by machineId + correlate
  // by requestId. Regression guard: without this relay the web progress bar
  // never receives data.
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new ReadyReconcileDeterministicOrchestrator(undefined, undefined, tracer);
  const captured: Array<{ room: string; event: string; payload: unknown }> = [];
  (orchestrator as unknown as { io: ReturnType<typeof makeFakeServerIO> }).io = makeFakeServerIO(captured);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "computer:restart:done",
    requestId: "restart-1",
    ok: true,
  } as MachineToServerMessage);
  assert.deepEqual(captured.find((e) => e.event === "computer:restart:done"), {
    room: "server:server-1",
    event: "computer:restart:done",
    payload: {
      machineId: "machine-1",
      type: "computer:restart:done",
      requestId: "restart-1",
      ok: true,
    },
  });

  await orchestrator.handleMachineMessage("machine-1", {
    type: "computer:upgrade:progress",
    requestId: "req-1",
    phase: "downloading",
    message: "downloading 0.0.36",
    percent: 42,
  } as MachineToServerMessage);
  assert.deepEqual(captured.find((e) => e.event === "computer:upgrade:progress"), {
    room: "server:server-1",
    event: "computer:upgrade:progress",
    payload: {
      machineId: "machine-1",
      type: "computer:upgrade:progress",
      requestId: "req-1",
      phase: "downloading",
      message: "downloading 0.0.36",
      // Regression guard: percent MUST survive the relay (server forwards via
      // `{ machineId, ...msg }` spread). An earlier service.ts bug dropped
      // percent before the WS frame, freezing the web bar at the phase
      // milestone — the relay must not be the place it gets lost either.
      percent: 42,
    },
  });

  await orchestrator.handleMachineMessage("machine-1", {
    type: "computer:upgrade:done",
    requestId: "req-1",
    ok: true,
    newVersion: "0.0.36",
  } as MachineToServerMessage);
  assert.deepEqual(captured.find((e) => e.event === "computer:upgrade:done"), {
    room: "server:server-1",
    event: "computer:upgrade:done",
    payload: {
      machineId: "machine-1",
      type: "computer:upgrade:done",
      requestId: "req-1",
      ok: true,
      newVersion: "0.0.36",
    },
  });
  const relaySpans = sink.getTrace(traceId).filter((span) => span.name === "server.computer.control.relay");
  assert.equal(relaySpans.length, 3, "restart, progress, and done relays are traceable by requestId");
  assert.deepEqual(relaySpans.map((span) => span.attrs?.event_type), [
    "computer:restart:done",
    "computer:upgrade:progress",
    "computer:upgrade:done",
  ]);
  assert.equal(relaySpans[0]?.attrs?.request_id, "restart-1");
  assert.equal(relaySpans[0]?.attrs?.ok, true);
  assert.equal(relaySpans[1]?.attrs?.request_id, "req-1");
  assert.equal(relaySpans[1]?.attrs?.phase, "downloading");
  assert.equal(relaySpans[1]?.attrs?.percent_bucket, 40);
  assert.equal(relaySpans[2]?.attrs?.ok, true);
  assert.equal(relaySpans[2]?.attrs?.new_version_present, true);
  orchestrator.shutdown();
});

test("restart failure replay only receipts the durable terminal winner for typed and fallback reasons", async () => {
  for (const [error, reason] of [
    ["control_busy", "control_busy"],
    ["self_relaunch_unavailable", "self_relaunch_unavailable"],
    ["unexpected_restart_error", "restart_reported_failure"],
  ] as const) {
    const orchestrator = new RestartFailureTerminalizationOrchestrator([
      "terminal",
      "late_after_terminal",
    ]);
    seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
    const frame = {
      type: "computer:restart:done",
      requestId: `restart-${error}`,
      ok: false,
      error,
    } as MachineToServerMessage;
    await orchestrator.handleMachineMessage("machine-1", frame);
    await orchestrator.handleMachineMessage("machine-1", frame);

    assert.deepEqual(orchestrator.terminalizations, [{
      operationId: `restart-${error}`,
      terminal: "failed",
      reason,
    }, {
      operationId: `restart-${error}`,
      terminal: "failed",
      reason,
    }]);
    assert.deepEqual(
      orchestrator.lifecycleReceipts.map((receipt) => receipt.phase),
      ["shutdown", "ready"],
    );
    assert.ok(orchestrator.lifecycleReceipts.every(
      (receipt) => receipt.operationId === `restart-${error}`,
    ));
    orchestrator.shutdown();
  }
});

test("rejected restart terminalization preserves the machine phase for retry with zero receipts", async () => {
  const orchestrator = new RestartFailureTerminalizationOrchestrator(["rejected"]);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "computer:restart:done",
    requestId: "restart-rejected",
    ok: false,
    error: "control_busy",
  } as MachineToServerMessage);

  assert.deepEqual(orchestrator.terminalizations, [{
    operationId: "restart-rejected",
    terminal: "failed",
    reason: "control_busy",
  }]);
  assert.deepEqual(orchestrator.lifecycleReceipts, []);
  orchestrator.shutdown();
});

test("upgrade failure replay receipts once after durable terminalization and rejected stays retryable", async () => {
  const operationId = "upgrade-failure";
  const replayOrchestrator = new RestartFailureTerminalizationOrchestrator([
    "terminal",
    "late_after_terminal",
  ]);
  seedMachineConnection(replayOrchestrator, "machine-1", makeFakeWs());
  const frame = {
    type: "computer:upgrade:done",
    requestId: operationId,
    ok: false,
    newVersion: "1.0.8",
  } as MachineToServerMessage;

  await replayOrchestrator.handleMachineMessage("machine-1", frame);
  await replayOrchestrator.handleMachineMessage("machine-1", frame);

  assert.deepEqual(replayOrchestrator.terminalizations, [{
    operationId,
    terminal: "failed",
    reason: "upgrade_reported_failure",
  }, {
    operationId,
    terminal: "failed",
    reason: "upgrade_reported_failure",
  }]);
  assert.deepEqual(
    replayOrchestrator.lifecycleReceipts.map((receipt) => receipt.phase),
    ["shutdown", "ready"],
  );
  assert.ok(replayOrchestrator.lifecycleReceipts.every((receipt) => receipt.operationId === operationId));
  replayOrchestrator.shutdown();

  const rejectedOrchestrator = new RestartFailureTerminalizationOrchestrator(["rejected"]);
  seedMachineConnection(rejectedOrchestrator, "machine-1", makeFakeWs());
  await rejectedOrchestrator.handleMachineMessage("machine-1", frame);
  assert.deepEqual(rejectedOrchestrator.lifecycleReceipts, []);
  rejectedOrchestrator.shutdown();
});

test("ready reconciliation records model-seen boundary capability per live machine", async () => {
  const orchestrator = new ReadyReconcileDeterministicOrchestrator();
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  seedMachineConnection(orchestrator, "machine-2", makeFakeWs());

  assert.equal(orchestrator.hasMachineCapability("machine-1", DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY), false);
  assert.equal(orchestrator.hasMachineCapability("machine-2", DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY), false);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY],
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: [],
  } as MachineToServerMessage);

  await orchestrator.handleMachineMessage("machine-2", {
    type: "ready",
    capabilities: [],
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: [],
  } as MachineToServerMessage);

  assert.equal(orchestrator.hasMachineCapability("machine-1", DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY), true);
  assert.equal(orchestrator.hasMachineCapability("machine-2", DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY), false);
  assert.equal(orchestrator.hasMachineCapability("machine-1", "agent:unrelated-capability"), false);
  assert.equal(orchestrator.hasMachineCapability("missing-machine", DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY), false);
  orchestrator.shutdown();
});

test("ready reconciliation replaces stale model-seen boundary capability on later ready", async () => {
  const orchestrator = new ReadyReconcileDeterministicOrchestrator();
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY],
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: [],
  } as MachineToServerMessage);
  assert.equal(orchestrator.hasMachineCapability("machine-1", DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY), true);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [],
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: [],
  } as MachineToServerMessage);

  assert.equal(orchestrator.hasMachineCapability("machine-1", DAEMON_CAPABILITY_MODEL_SEEN_BOUNDARY), false);
  orchestrator.shutdown();
});

test("ready reconciliation does not resurrect an agent while a session reset is still in progress", async () => {
  const orchestrator = new (class extends DeferredResetWindowOrchestrator {
    protected override async persistMachineCapabilities(
      _machineId: string,
      _runtimes: string[],
      _hostname?: string,
      _os?: string,
      _daemonVersion?: string | null,
    ) {
      // No-op for determ tests.
    }

    protected override async loadAgentsForReadyReconcile(machineId: string) {
      const agents = [...(this as any).agentStateCache.entries()]
        .filter(([, agent]) => agent.machineId === machineId)
        .map(([id, agent]) => ({
          id,
          serverId: agent.serverId,
          machineId: agent.machineId,
          sessionId: agent.sessionId,
          status: agent.status,
          name: agent.name,
          displayName: agent.displayName,
          avatarUrl: null,
          description: agent.description,
          model: agent.model,
          runtime: agent.runtime,
          reasoningEffort: agent.reasoningEffort,
          envVars: agent.envVars,
          executionMode: "cloud",
          deletedAt: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }));
      return agents as Awaited<ReturnType<DeterministicAgentOrchestrator["loadAgentForStart"]>>[];
    }
  })();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const resetPromise = orchestrator.resetAgent("agent-1", "session");
  await flushMicrotasks();
  assert.equal(orchestrator.inactivePersistEntered, true);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "inactive");

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: ["agent-1"],
  } as MachineToServerMessage);

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "inactive");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "Stopped" });
  assert.deepEqual(
    orchestrator.sentToMachine.map((msg) => msg.type),
    ["agent:stop", "agent:stop"],
  );

  orchestrator.inactivePersistGate.resolve();
  await resetPromise;
  orchestrator.shutdown();
});

test("ready reconcile apply force-stop keeps the persisted status and emits offline", async () => {
  const orchestrator = new ReadyReconcileDeterministicOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  await orchestrator.stopAgent("agent-1");

  await orchestrator.callApplyReadyReconcileAction("machine-1", "agent-1", "force-stop-and-stay-offline");

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "stopped");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "Stopped" });
  assert.deepEqual(
    orchestrator.sentToMachine.map((msg) => msg.type),
    ["agent:stop", "agent:stop"],
  );
  orchestrator.shutdown();
});

test("ready reconcile apply mark-active persists active and emits online", async () => {
  const orchestrator = new ReadyReconcileDeterministicOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  (orchestrator as any).updateCache("agent-1", { status: "inactive" });

  await orchestrator.callApplyReadyReconcileAction("machine-1", "agent-1", "mark-active-online");

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "active");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });
  assert.equal(orchestrator.sentToMachine.length, 0);
  orchestrator.shutdown();
});

test("ready reconcile apply mark-wakeable-not-running preserves active and does not show offline", async () => {
  const orchestrator = new ReadyReconcileDeterministicOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.callApplyReadyReconcileAction("machine-1", "agent-1", "mark-wakeable-not-running");

  const cached = (orchestrator as any).agentStateCache.get("agent-1");
  assert.equal(cached.status, "active");
  assert.equal(cached.runtimeState, "not_running");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });
  assert.equal(orchestrator.sentToMachine.length, 0);
  orchestrator.shutdown();
});

test("slock CLI producer action is durably persisted and emitted as a slock action entry", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(45_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  orchestrator.recordRaftCliAction("agent-1", {
    command: "message.send",
    summary: "Sent message",
    target: "#proj-runtime:9debd7fb",
    correlationId: "msg-1",
  });
  await flushMicrotasks();

  const entry: TrajectoryEntry = {
    kind: "slock_action",
    title: "Sent message",
    text: "target: #proj-runtime:9debd7fb",
  };
  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [{
    timestamp: clock.now(),
    entry,
  }]);
  assert.deepEqual(orchestrator.emittedActivityPayloads.at(-1), {
    agentId: "agent-1",
    activity: "online",
    activityKind: "online",
    detail: "",
    detailKind: "none",
    timestamp: clock.now(),
    serverSeq: 1,
  });

  orchestrator.shutdown();
});

test("explicit slock action activity persists status entry for reload recovery", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(46_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.recordAgentRaftAction("agent-1", {
    title: "Send held by freshness check",
    text: "new messages: 1 newer message",
    producerFactId: "freshness_decision_fact:server-held",
    activity: "working",
    activityDetail: "Send held by freshness check",
  });

  const entries: TrajectoryEntry[] = [
    {
      kind: "status",
      activity: "working",
      activityKind: "working",
      detail: "Send held by freshness check",
      detailKind: "slock_action",
      producerFactId: "freshness_decision_fact:server-held",
    },
    {
      kind: "slock_action",
      title: "Send held by freshness check",
      text: "new messages: 1 newer message",
      producerFactId: "freshness_decision_fact:server-held",
    },
  ];
  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), entries.map((entry) => ({
    timestamp: clock.now(),
    entry,
  })));
  assert.deepEqual(orchestrator.emittedActivityPayloads.at(-1), {
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "Send held by freshness check",
    detailKind: "slock_action",
    timestamp: clock.now(),
    serverSeq: 1,
  });

  orchestrator.shutdown();
});

test("freshness held current terminalizes at daemon inactive boundary", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(46_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock, tracer);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.recordAgentRaftAction("agent-1", {
    title: "Send held by freshness check",
    text: "new messages: 1 newer message",
    producerFactId: "freshness_decision_fact:server-held",
    activity: "working",
    activityDetail: "Send held by freshness check",
  });
  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), {
    activity: "working",
    detail: "Send held by freshness check",
    detailKind: "slock_action",
    updatedAt: clock.now(),
  });

  clock.advance(1_000);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:status",
    agentId: "agent-1",
    status: "inactive",
    launchId: "launch-1",
  } as MachineToServerMessage);
  await flushMicrotasks();

  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), {
    activity: "online",
    detail: "",
    detailKind: "idle",
    updatedAt: clock.now(),
  });
  const terminalEntry: TrajectoryEntry = {
    kind: "status",
    activity: "online",
    activityKind: "online",
    detail: "",
    detailKind: "idle",
    producerFactId: "lifecycle_plan:freshness_hold_terminalized",
  };
  const recentLog = await orchestrator.listRecentActivityLog("agent-1");
  assert.deepEqual(recentLog.at(-1), {
    timestamp: clock.now(),
    entry: terminalEntry,
  });
  assert.deepEqual(orchestrator.emittedActivityPayloads.at(-1), {
    agentId: "agent-1",
    activity: "online",
    activityKind: "online",
    detail: "",
    detailKind: "idle",
    timestamp: clock.now(),
    producerFactId: "lifecycle_plan:freshness_hold_terminalized",
    serverSeq: 2,
  });
  const terminalizeEvent = sink.getTrace(traceId)
    .flatMap((span) => span.events)
    .find((event) => event.name === "freshness_hold.terminalize");
  assert.ok(terminalizeEvent, "inactive lifecycle span must record freshness terminalization reason");
  assert.equal(terminalizeEvent.attrs?.outcome, "resolved");
  assert.equal(terminalizeEvent.attrs?.reason, "freshness_hold_terminalized");

  orchestrator.shutdown();
});

test("freshness held current terminalization is admitted when kernel arbitration is enabled", async () => {
  await withKernelEnvAsync(true, async () => {
    const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
    const clock = new FakeClock();
    clock.advance(46_000);
    const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock);
    seedActiveAgent(orchestrator);
    seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

    await orchestrator.recordAgentRaftAction("agent-1", {
      title: "Send held by freshness check",
      text: "new messages: 1 newer message",
      producerFactId: "freshness_decision_fact:server-held",
      activity: "working",
      activityDetail: "Send held by freshness check",
    });

    clock.advance(1_000);
    await orchestrator.handleMachineMessage("machine-1", {
      type: "agent:status",
      agentId: "agent-1",
      status: "inactive",
      launchId: "launch-1",
    } as MachineToServerMessage);
    await flushMicrotasks();

    assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), {
      activity: "online",
      detail: "",
      detailKind: "idle",
      observedAtMs: 46_000,
      updatedAt: clock.now(),
    });
    assert.equal(orchestrator.emittedActivityPayloads.at(-1)?.activity, "online");
    assert.equal(orchestrator.emittedActivityPayloads.at(-1)?.detailKind, "idle");
    assert.equal(orchestrator.emittedActivityPayloads.at(-1)?.producerFactId, "lifecycle_plan:freshness_hold_terminalized");
    assert.deepEqual((await orchestrator.listRecentActivityLog("agent-1")).at(-1)?.entry, {
      kind: "status",
      activity: "online",
      activityKind: "online",
      detail: "",
      detailKind: "idle",
      producerFactId: "lifecycle_plan:freshness_hold_terminalized",
    });

    orchestrator.shutdown();
  });
});

test("freshness held current is not terminalized by same-launch active status", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(46_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.recordAgentRaftAction("agent-1", {
    title: "Send held by freshness check",
    text: "new messages: 1 newer message",
    producerFactId: "freshness_decision_fact:server-held",
    activity: "working",
    activityDetail: "Send held by freshness check",
  });
  const emittedBeforeStatus = orchestrator.emittedActivityPayloads.length;

  clock.advance(1_000);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:status",
    agentId: "agent-1",
    status: "active",
    launchId: "launch-1",
  } as MachineToServerMessage);
  await flushMicrotasks();

  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), {
    activity: "working",
    detail: "Send held by freshness check",
    detailKind: "slock_action",
    updatedAt: 46_000,
  });
  assert.equal(orchestrator.emittedActivityPayloads.length, emittedBeforeStatus);

  orchestrator.shutdown();
});

test("activity producer event normalizes multiline fields before persistence", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(50_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  orchestrator.recordActivityProducerEvent("agent-1", {
    producer: "runtime_tool",
    summary: "Ran\nshell command",
    outcome: "failed",
    target: "line one\nline two",
  });
  await flushMicrotasks();

  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [{
    timestamp: clock.now(),
    entry: {
      kind: "slock_action",
      title: "Ran shell command",
      text: [
        "target: line one line two",
        "status: failed",
      ].join("\n"),
    },
  }]);

  orchestrator.shutdown();
});

test("ready reconcile after machine disconnect durably records online recovery", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(10_000);
  const orchestrator = new ReadyReconcileActivityLogDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  const disconnectedWs = makeFakeWs();
  seedMachineConnection(orchestrator, "machine-1", disconnectedWs);

  await orchestrator.handleMachineDisconnect("machine-1", disconnectedWs as never, { cause: "socket_close" });
  await advanceClockAndWaitForCondition(
    clock,
    2000,
    () => orchestrator.emittedActivityPayloads.some((payload) => payload.activity === "offline"),
  );

  clock.advance(3_000);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: ["agent-1"],
  } as MachineToServerMessage);
  await flushMicrotasks();

  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [
    { timestamp: 12_000, entry: { kind: "status", activity: "offline", activityKind: "offline", detail: "Machine disconnected", detailKind: "machine_disconnected" } },
    { timestamp: 15_000, entry: { kind: "status", activity: "online", activityKind: "online", detail: "", detailKind: "none" } },
  ]);
  assert.deepEqual(orchestrator.emittedActivityPayloads.at(-1), {
    agentId: "agent-1",
    activity: "online",
    activityKind: "online",
    detail: "",
    detailKind: "none",
    timestamp: 15_000,
    serverSeq: 2,
  });
  orchestrator.shutdown();
});

test("daemon activity after reconnect updates agents that ready reconcile kept wakeable", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(10_000);
  const orchestrator = new ReadyReconcileActivityLogDeterministicOrchestrator(persistedLogs, clock);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedActiveAgent(orchestrator, "agent-2", "machine-1");
  const disconnectedWs = makeFakeWs();
  seedMachineConnection(orchestrator, "machine-1", disconnectedWs);

  await orchestrator.handleMachineDisconnect("machine-1", disconnectedWs as never, { cause: "socket_close" });
  await advanceClockAndWaitForCondition(
    clock,
    2000,
    () => orchestrator.emittedActivityPayloads.some((payload) => payload.activity === "offline"),
  );

  clock.advance(3_000);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [],
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: [],
  } as MachineToServerMessage);
  await flushMicrotasks();

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "active");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").runtimeState, "not_running");
  assert.equal((orchestrator as any).agentStateCache.get("agent-2").status, "active");
  assert.equal((orchestrator as any).agentStateCache.get("agent-2").runtimeState, "not_running");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });
  assert.deepEqual(await orchestrator.getActivity("agent-2"), { activity: "online", activityDetail: "" });

  clock.advance(5_000);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "thinking",
    detail: "Continuing work",
    entries: [{ kind: "thinking", text: "Continuing work" }],
  } as MachineToServerMessage);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-2",
    activity: "working",
    detail: "Running tool",
    entries: [{ kind: "tool_start", toolName: "shell", toolInput: "pnpm test" }],
  } as MachineToServerMessage);
  await flushMicrotasks();

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "active");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").runtimeState, "thinking");
  assert.equal((orchestrator as any).agentStateCache.get("agent-2").status, "active");
  assert.equal((orchestrator as any).agentStateCache.get("agent-2").runtimeState, "working");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "thinking", activityDetail: "Continuing work" });
  assert.deepEqual(await orchestrator.getActivity("agent-2"), { activity: "working", activityDetail: "Running tool" });
  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [
    { timestamp: 12_000, entry: { kind: "status", activity: "offline", activityKind: "offline", detail: "Machine disconnected", detailKind: "machine_disconnected" } },
    { timestamp: 15_000, entry: { kind: "status", activity: "online", activityKind: "online", detail: "", detailKind: "none" } },
    { timestamp: 20_000, entry: { kind: "thinking", text: "Continuing work" } },
  ]);
  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-2"), [
    { timestamp: 12_000, entry: { kind: "status", activity: "offline", activityKind: "offline", detail: "Machine disconnected", detailKind: "machine_disconnected" } },
    { timestamp: 15_000, entry: { kind: "status", activity: "online", activityKind: "online", detail: "", detailKind: "none" } },
    { timestamp: 20_000, entry: { kind: "tool_start", toolName: "shell", toolInput: "pnpm test" } },
  ]);
  orchestrator.shutdown();
});

test("ready reconcile repeated missing-agent projections do not create offline activity logs", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(10_000);
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new ReadyReconcileActivityLogDeterministicOrchestrator(persistedLogs, clock, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [],
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: [],
  } as MachineToServerMessage);

  clock.advance(5_000);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [],
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: [],
  } as MachineToServerMessage);

  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), []);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });

  const activityLogProjections = lifecycleProjectionAttrs(sink, traceId)
    .filter((attrs) => attrs.projection_kind === "activity_log" && attrs.label_kind === "ready_wakeable_not_running");
  assert.equal(activityLogProjections.length, 2);
  assert.deepEqual(activityLogProjections.map((attrs) => attrs.outcome), ["skipped", "skipped"]);
  orchestrator.shutdown();
});

test("machine disconnect projects wake ineligible while the machine is unreachable", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(10_000);
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new ReadyReconcileActivityLogDeterministicOrchestrator(persistedLogs, clock, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  const ws = makeFakeWs();
  seedMachineConnection(orchestrator, "machine-1", ws);

  await orchestrator.handleMachineDisconnect("machine-1", ws as never, { cause: "socket_close" });
  await advanceClockAndWaitForCondition(
    clock,
    2000,
    () => lifecycleProjectionAttrs(sink, traceId).some((attrs) => attrs.projection_kind === "wake_eligibility"),
  );

  const [wakeProjection] = lifecycleProjectionAttrs(sink, traceId)
    .filter((attrs) => attrs.projection_kind === "wake_eligibility");
  assert.ok(wakeProjection);
  assert.equal(wakeProjection.wake_eligibility, false);
  assert.equal(wakeProjection.wake_block_reason, "machine_unreachable");
  assert.equal(wakeProjection.machine_reachability, "unreachable");
  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [
    { timestamp: 12_000, entry: { kind: "status", activity: "offline", activityKind: "offline", detail: "Machine disconnected", detailKind: "machine_disconnected" } },
  ]);
  orchestrator.shutdown();
});

test("machine shutdown intent projects active agents as stopped control intent", async () => {
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const clock = new FakeClock();
  clock.advance(10_000);
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new ReadyReconcileActivityLogDeterministicOrchestrator(persistedLogs, clock, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  const ws = makeFakeWs();
  seedMachineConnection(orchestrator, "machine-1", ws);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "machine:shutdown",
    reason: "computer_stop",
  } as MachineToServerMessage);
  await orchestrator.handleMachineDisconnect("machine-1", ws as never, { cause: "socket_close" });
  await advanceClockAndWaitForCondition(
    clock,
    2000,
    () => orchestrator.emittedActivityPayloads.some((payload) => payload.detail === "Computer stopped"),
  );

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "active");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").runtimeState, "not_running");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "Computer stopped" });
  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [
    { timestamp: 12_000, entry: { kind: "status", activity: "offline", activityKind: "offline", detail: "Computer stopped", detailKind: "stopped" } },
  ]);

  const projections = lifecycleProjectionAttrs(sink, traceId);
  const dbStatusProjection = projections.find((attrs) => attrs.projection_kind === "db_status");
  assert.ok(dbStatusProjection);
  assert.equal(dbStatusProjection.outcome, "skipped");
  assert.equal(dbStatusProjection.projection_skipped_reason, "machine_shutdown_preserves_agent_status");
  assert.equal(dbStatusProjection.shutdown_reason, "computer_stop");

  const verdicts = sink.getAllSpans()
    .flatMap((span) => span.events)
    .filter((event) => event.name === "lifecycle_v2.shadow_verdict")
    .map((event) => event.attrs ?? {});
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].shadow_signal_site, "lifecycle_plan");
  assert.equal(verdicts[0].shadow_plan_kind, "manual_stop_requested");
  assert.equal(verdicts[0].shadow_observation_class, "control_intent");
  assert.equal(verdicts[0].event_kind, "stop_requested");

  orchestrator.shutdown();
});

test("ready reconcile does not overwrite fresh busy activity with idle online", async () => {
  const clock = new FakeClock();
  clock.advance(5_000);
  const orchestrator = new ReadyReconcileActivityLogDeterministicOrchestrator(new Map(), clock);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "Editing file…",
    entries: [{ kind: "tool_start", toolName: "edit_file", toolInput: "src/App.tsx" }],
    launchId: "current-running-launch",
  } as MachineToServerMessage);

  await flushMicrotasks();
  const emittedBeforeReady = orchestrator.emittedActivityPayloads.length;
  await orchestrator.callApplyReadyReconcileAction("machine-1", "agent-1", "mark-active-online");

  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "working",
    activityDetail: "Editing file…",
  });
  assert.equal(
    orchestrator.emittedActivityPayloads.slice(emittedBeforeReady).some((payload) => payload.activity === "online"),
    false,
  );
  orchestrator.shutdown();
});

test("ready reconcile clears stale launch guard so resumed daemon activity is accepted", async () => {
  const clock = new FakeClock();
  clock.advance(5_000);
  const orchestrator = new ReadyReconcileActivityLogDeterministicOrchestrator(new Map(), clock);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  (orchestrator as any).updateCache("agent-1", {
    status: "inactive",
    expectedLaunchId: "stale-launch",
    launchGuardMode: "guarded",
  });

  await orchestrator.callApplyReadyReconcileAction("machine-1", "agent-1", "mark-active-online");

  const agent = (orchestrator as any).agentStateCache.get("agent-1");
  assert.equal(agent.expectedLaunchId, null);
  assert.equal(agent.launchGuardMode, "legacy");

  const entries: TrajectoryEntry[] = [{ kind: "status", activity: "working", detail: "Message received" }];
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "Message received",
    entries,
    launchId: "current-running-launch",
  } as MachineToServerMessage);

  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), entries.map((entry) => ({
    timestamp: clock.now(),
    entry: entry.kind === "status"
      ? { ...entry, activityKind: entry.activity }
      : entry,
  })));
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "working",
    activityDetail: "Message received",
  });
  orchestrator.shutdown();
});

test("activity ingestion trace records accepted activity log and read-model update", async () => {
  const clock = new FakeClock();
  clock.advance(5_000);
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new ReadyReconcileActivityLogDeterministicOrchestrator(new Map(), clock, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  (orchestrator as any).updateCache("agent-1", {
    status: "inactive",
    expectedLaunchId: "stale-launch",
    launchGuardMode: "guarded",
  });

  await orchestrator.callApplyReadyReconcileAction("machine-1", "agent-1", "mark-active-online");
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "Message received",
    entries: [{ kind: "status", activity: "working", detail: "Message received" }],
    launchId: "current-running-launch",
    clientSeq: 9,
    producerFactId: "daemon_activity:agent-1:current-running-launch:9",
  } as MachineToServerMessage);

  const [span] = sink.getTrace(traceId).filter((candidate) => candidate.name === "server.agent.activity.ingest");
  assert.ok(span);
  assert.equal(span.attrs?.outcome, "accepted");
  assert.equal(span.attrs?.agent_id_present, true);
  assert.equal(span.attrs?.machine_id_present, true);
  assert.equal(span.attrs?.normalized_activity, "working");
  assert.equal(span.attrs?.activity_status, "working");
  assert.equal(span.attrs?.live_activity_updated, true);
  assert.equal(span.attrs?.previous_activity_status, "online");
  assert.equal(span.attrs?.next_activity_status, "working");
  assert.equal(span.attrs?.activity_transition, "online->working");
  assert.equal(span.attrs?.activity_log_entry_count, 1);
  assert.equal(span.attrs?.launch_id, "current-running-launch");
  assert.equal(span.attrs?.daemon_instance_id_present, false);
  assert.equal(span.attrs?.activity_sequence_generation, "legacy_server_epoch");
  assert.equal(span.attrs?.client_seq, 9);
  assert.equal(span.attrs?.producer_fact_id, "daemon_activity:agent-1:current-running-launch:9");
  assert.equal(span.attrs?.correlation_id, "daemon_activity:agent-1:current-running-launch:9");
  assert.equal(Object.values(span.attrs ?? {}).includes("agent-1"), false);
  assert.equal(Object.values(span.attrs ?? {}).includes("machine-1"), false);
  const eventNames = span.events.map((event) => event.name);
  assert.deepEqual(eventNames.slice(0, 3), [
    "activity.ingest.received",
    "lifecycle_guard.checked",
    "activity.ingest.accepted",
  ]);
  assert.equal(
    span.events.find((event) => event.name === "activity.ingest.accepted")?.attrs?.producer_fact_id,
    "daemon_activity:agent-1:current-running-launch:9",
  );
  assert.equal(eventNames.includes("agent.lifecycle.event"), true);
  assert.equal(eventNames.filter((name) => name === "agent.lifecycle.projection").length, 4);
  assert.deepEqual(eventNames.slice(-2), [
    "status.read_model.updated",
    "activity.log.persist_scheduled",
  ]);
  assert.deepEqual(span.events.find((event) => event.name === "lifecycle_guard.checked")?.attrs, {
    action: "accept",
    guardMode: "legacy",
    hasExpectedLaunchId: false,
    hasLaunchId: true,
  });
  assert.deepEqual(span.events.find((event) => event.name === "status.read_model.updated")?.attrs, {
    from: "online",
    to: "working",
  });
  assert.equal(
    span.events.find((event) => event.name === "activity.log.persist_scheduled")?.attrs?.entryCount,
    1,
  );
  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "working",
    activityDetail: "Message received",
  });
  orchestrator.shutdown();
});

test("activity ingestion trace records stale launch guard drops before read-model update", async () => {
  const clock = new FakeClock();
  clock.advance(5_000);
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new ReadyReconcileActivityLogDeterministicOrchestrator(new Map(), clock, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  (orchestrator as any).updateCache("agent-1", {
    status: "active",
    expectedLaunchId: "expected-launch",
    launchGuardMode: "guarded",
  });

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "Message received",
    entries: [{ kind: "status", activity: "working", detail: "Message received" }],
    launchId: "stale-launch",
    clientSeq: 1,
    producerFactId: "daemon_activity:agent-1:stale-launch:1",
  } as MachineToServerMessage);

  const [span] = sink.getTrace(traceId).filter((candidate) => candidate.name === "server.agent.activity.ingest");
  assert.ok(span);
  assert.equal(span.attrs?.outcome, "dropped");
  assert.equal(span.attrs?.reason, "stale_launch_guard");
  assert.equal(span.attrs?.agent_id_present, true);
  assert.equal(span.attrs?.machine_id_present, true);
  assert.equal(span.attrs?.producer_fact_id, "daemon_activity:agent-1:stale-launch:1");
  assert.equal(span.attrs?.correlation_id, "daemon_activity:agent-1:stale-launch:1");
  assert.equal(Object.values(span.attrs ?? {}).includes("agent-1"), false);
  assert.equal(Object.values(span.attrs ?? {}).includes("machine-1"), false);
  assert.deepEqual(span.events.map((event) => event.name), [
    "activity.ingest.received",
    "lifecycle_guard.checked",
    "activity.ingest.dropped",
  ]);
  assert.equal(
    span.events.find((event) => event.name === "activity.ingest.dropped")?.attrs?.reason,
    "stale_launch_guard",
  );
  assert.equal(
    span.events.find((event) => event.name === "activity.ingest.dropped")?.attrs?.producer_fact_id,
    "daemon_activity:agent-1:stale-launch:1",
  );
  assert.equal(span.events.some((event) => event.name === "status.read_model.updated"), false);
  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), []);
  orchestrator.shutdown();
});

test("ready reconcile apply stay-offline preserves non-active status without sending commands", async () => {
  const orchestrator = new ReadyReconcileDeterministicOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  (orchestrator as any).updateCache("agent-1", { status: "inactive" });

  await orchestrator.callApplyReadyReconcileAction("machine-1", "agent-1", "stay-offline");

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "inactive");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "Runtime interrupted" });
  assert.equal(orchestrator.sentToMachine.length, 0);
  orchestrator.shutdown();
});

test("ready reconcile marks missing active agents wakeable without eager startup", async () => {
  const orchestrator = new ReadyReconcileDeterministicOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.callApplyReadyReconcileAction("machine-1", "agent-1", "mark-wakeable-not-running");

  const cached = (orchestrator as any).agentStateCache.get("agent-1");
  assert.equal(cached.status, "active");
  assert.equal(cached.runtimeState, "not_running");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });
  assert.equal(orchestrator.sentToMachine.length, 0);
  orchestrator.shutdown();
});

test("ready reconciliation does not eager-start active agents that are missing from daemon ready", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new ReadyReconcileDeterministicOrchestrator(undefined, undefined, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedActiveAgent(orchestrator, "agent-2", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [],
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: [],
  } as MachineToServerMessage);

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "active");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").runtimeState, "not_running");
  assert.equal((orchestrator as any).agentStateCache.get("agent-2").status, "active");
  assert.equal((orchestrator as any).agentStateCache.get("agent-2").runtimeState, "not_running");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });
  assert.deepEqual(await orchestrator.getActivity("agent-2"), { activity: "online", activityDetail: "" });
  assert.equal(orchestrator.sentToMachine.length, 0);
  const readySpan = sink.getTrace(traceId).find((span) => span.name === "server.machine.ready.reconcile");
  assert.ok(readySpan);
  assert.equal(readySpan.attrs?.mark_wakeable_not_running_count, 2);
  assert.equal(readySpan.attrs?.mark_inactive_offline_count, 0);
  assert.equal(readySpan.attrs?.request_start_count, 0);
  orchestrator.shutdown();
});

test("ready reconciliation wakes a missing active agent when a message arrived during reconnect", async () => {
  const orchestrator = new ReadyReconcileDeterministicOrchestrator();
  const message = makeAgentMessage("message while daemon was reconnecting", 7);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  // Simulates the persisted message fanout path while the daemon has no
  // running runtime process yet. Ready reconciliation must not strand this
  // server-side inbox behind a user-visible "online" projection.
  orchestrator.deliverToLocalInbox("agent-1", message);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [],
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: [],
  } as MachineToServerMessage);

  assert.deepEqual(
    orchestrator.sentToMachine.map((msg) => ({ type: msg.type, agentId: "agentId" in msg ? msg.agentId : null })),
    [{ type: "agent:start", agentId: "agent-1" }],
  );
  const startMessage = orchestrator.sentToMachine[0];
  assert.equal(startMessage?.type, "agent:start");
  assert.deepEqual(startMessage.wakeMessage, message);
  assert.equal((orchestrator as any).agentInboxes.get("agent-1")?.inbox.length ?? 0, 0);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").runtimeState, "starting");
  orchestrator.shutdown();
});

test("ready reconciliation does not wake a manually stopped agent with pending inbox", async () => {
  const orchestrator = new ReadyReconcileDeterministicOrchestrator();
  const message = makeAgentMessage("message after manual stop", 8);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  (orchestrator as any).agentStateCache.get("agent-1").status = "stopped";
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  orchestrator.deliverToLocalInbox("agent-1", message);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [],
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: [],
  } as MachineToServerMessage);

  assert.equal(orchestrator.sentToMachine.length, 0);
  assert.deepEqual((orchestrator as any).agentInboxes.get("agent-1")?.inbox ?? [], [message]);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "stopped");
  orchestrator.shutdown();
});

test("post-ready message lazy-wakes only the target agent after missing active agents were marked wakeable", async () => {
  const orchestrator = new ReadyReconcileDeterministicOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedActiveAgent(orchestrator, "agent-2", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [],
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: [],
  } as MachineToServerMessage);

  await orchestrator.deliverMessage("agent-2", makeAgentMessage("wake only agent 2"));

  assert.deepEqual(
    orchestrator.sentToMachine.map((msg) => ({ type: msg.type, agentId: "agentId" in msg ? msg.agentId : null })),
    [{ type: "agent:start", agentId: "agent-2" }],
  );
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "active");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").runtimeState, "not_running");
  assert.equal((orchestrator as any).agentStateCache.get("agent-2").status, "active");
  assert.equal((orchestrator as any).agentStateCache.get("agent-2").runtimeState, "starting");
  orchestrator.shutdown();
});

test("ready reconciliation seeds cold cache so post-refresh messages lazy-wake", async () => {
  const orchestrator = new ColdCacheReadyReconcileDeterministicOrchestrator();
  orchestrator.addPersistedActiveAgent("agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [],
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: [],
  } as MachineToServerMessage);

  const cachedAfterReady = (orchestrator as any).agentStateCache.get("agent-1");
  assert.equal(cachedAfterReady.status, "active");
  assert.equal(cachedAfterReady.runtimeState, "not_running");

  await orchestrator.deliverMessage("agent-1", makeAgentMessage("wake after daemon refresh", 9));

  assert.deepEqual(
    orchestrator.sentToMachine.map((msg) => ({ type: msg.type, agentId: "agentId" in msg ? msg.agentId : null })),
    [{ type: "agent:start", agentId: "agent-1" }],
  );
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").runtimeState, "starting");
  orchestrator.shutdown();
});

test("ready reconciliation fails closed for an invalid persisted status when the daemon reports the agent as running", async () => {
  const orchestrator = new InvalidStatusReadyReconcileDeterministicOrchestrator("sleeping");
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: ["agent-1"],
  } as MachineToServerMessage);

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "inactive");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "Stopped" });
  assert.deepEqual(orchestrator.sentToMachine.map((msg) => msg.type), ["agent:stop"]);
  orchestrator.shutdown();
});

test("ready reconciliation fails closed for an invalid persisted status when the daemon does not report the agent as running", async () => {
  const orchestrator = new InvalidStatusReadyReconcileDeterministicOrchestrator("sleeping");
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [],
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: [],
  } as MachineToServerMessage);

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "inactive");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "Runtime interrupted" });
  assert.equal(orchestrator.sentToMachine.length, 0);
  orchestrator.shutdown();
});

test("startAgent records null previousStatus and rolls back to inactive for an invalid persisted status", async () => {
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new InvalidStatusStartDeterministicOrchestrator("sleeping", store, { sendSucceeds: false });

  await assert.rejects(() => orchestrator.startAgent("agent-1"), /Machine offline\. Please start your local daemon\./);

  assert.equal(store.wakeLocks.size, 0);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "inactive");
  assert.deepEqual(recentLifecycleEvents(orchestrator), [
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "start",
      outcome: "failed",
      cause: "manual",
      previousStatus: null,
      detail: "Machine offline. Please start your local daemon.",
    },
  ]);
  orchestrator.shutdown();
});

test("startAgent completes with null previousStatus for an invalid persisted status", async () => {
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new InvalidStatusStartDeterministicOrchestrator("sleeping", store);

  await orchestrator.startAgent("agent-1");

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "active");
  assert.deepEqual(recentLifecycleEvents(orchestrator), [
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "start",
      outcome: "completed",
      cause: "manual",
      previousStatus: null,
      nextStatus: "active",
    },
  ]);
  orchestrator.shutdown();
});

test("late agent activity does not overwrite visible activity after a manual stop", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.stopAgent("agent-1");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "Stopped" });

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "late activity after stop",
    entries: [],
  } as MachineToServerMessage);

  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "Stopped" });
  orchestrator.shutdown();
});

test("late agent activity does not overwrite visible activity during a session reset window", async () => {
  const orchestrator = new DeferredResetWindowOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const resetPromise = orchestrator.resetAgent("agent-1", "session");
  await flushMicrotasks();
  assert.equal(orchestrator.inactivePersistEntered, true);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "" });

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "late activity during reset",
    entries: [],
  } as MachineToServerMessage);

  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "" });
  orchestrator.inactivePersistGate.resolve();
  await resetPromise;
  orchestrator.shutdown();
});

test("concurrent reset request is skipped while an existing reset is in progress", async () => {
  const orchestrator = new DeferredResetWindowOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const resetPromise = orchestrator.resetAgent("agent-1", "restart");
  await flushMicrotasks();
  assert.equal(orchestrator.inactivePersistEntered, true);

  await orchestrator.resetAgent("agent-1", "restart");

  assert.deepEqual(
    orchestrator.sentToMachine.map((msg) => msg.type),
    ["agent:stop"],
  );
  assert.equal(
    recentLifecycleEvents(orchestrator).some((event) =>
      event.action === "reset"
      && event.outcome === "skipped"
      && event.detail === "reset_in_progress"
    ),
    true,
  );

  orchestrator.inactivePersistGate.resolve();
  await resetPromise;
  orchestrator.shutdown();
});

test("daemon inactive status does not overwrite a manually stopped agent back to inactive", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  (orchestrator as any).agentStateCache.get("agent-1").status = "stopped";

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:status",
    agentId: "agent-1",
    status: "inactive",
  } as MachineToServerMessage);

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "stopped");
  orchestrator.shutdown();
});

test("late agent session does not resurrect a manually stopped agent", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.stopAgent("agent-1");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "stopped");

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-late",
  } as MachineToServerMessage);

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "stopped");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").sessionId, null);
  orchestrator.shutdown();
});

test("late active status does not resurrect a manually stopped agent", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.stopAgent("agent-1");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "stopped");

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:status",
    agentId: "agent-1",
    status: "active",
  } as MachineToServerMessage);

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "stopped");
  orchestrator.shutdown();
});

type DeterministicAgentStatus = "active" | "inactive" | "stopped";

class PersistTrackingDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  readonly persistCalls: Array<{ source: "explicit" | "signal"; status: DeterministicAgentStatus; sessionId?: string }> = [];

  protected override async persistAgentStatus(_agentId: string, status: DeterministicAgentStatus, sessionId?: string) {
    this.persistCalls.push({ source: "explicit", status, sessionId });
  }

  protected override async persistAgentStatusFromSignal(_agentId: string, status: DeterministicAgentStatus, sessionId?: string) {
    this.persistCalls.push({ source: "signal", status, sessionId });
    return true;
  }
}

class NoSessionBroadcastReloadOrchestrator extends PersistTrackingDeterministicOrchestrator {
  sessionBroadcastReloadCalls = 0;

  protected override async loadAgentForSessionBroadcast(agentId: string): Promise<any> {
    this.sessionBroadcastReloadCalls += 1;
    throw new Error(`loadAgentForSessionBroadcast must not be called for ${agentId}`);
  }
}

class SignalWriteRejectedDeterministicOrchestrator extends PersistTrackingDeterministicOrchestrator {
  protected override async persistAgentStatusFromSignal(_agentId: string, status: DeterministicAgentStatus, sessionId?: string) {
    this.persistCalls.push({ source: "signal", status, sessionId });
    return false;
  }
}

class SessionInvalidationDeterministicOrchestrator extends PersistTrackingDeterministicOrchestrator {
  readonly invalidationCalls: Array<{ agentId: string; sessionId: string; machineId: string }> = [];
  invalidationApplied = true;

  protected override async invalidatePersistedAgentSessionFromSignal(
    agentId: string,
    sessionId: string,
    machineId: string,
  ) {
    this.invalidationCalls.push({ agentId, sessionId, machineId });
    return this.invalidationApplied;
  }
}

test("agent:session persist routes through the signal-protected API", async () => {
  // Cross-replica scenario: this replica's cache shows the agent as still active
  // (no stop happened locally), but DB may already be stopped from a peer replica.
  // The signal-protected DB API is what guards against the resurrection — the
  // orchestrator must route session writes through it.
  const orchestrator = new PersistTrackingDeterministicOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-late",
  } as MachineToServerMessage);

  assert.deepEqual(orchestrator.persistCalls, [
    { source: "signal", status: "active", sessionId: "session-late" },
  ]);
  orchestrator.shutdown();
});

test("agent:session:invalidate clears and broadcasts only when the exact DB session is invalidated", async () => {
  const orchestrator = new SessionInvalidationDeterministicOrchestrator();
  const captured: Array<{ room: string; event: string; payload: unknown }> = [];
  (orchestrator as unknown as { io: ReturnType<typeof makeFakeServerIO> }).io = makeFakeServerIO(captured);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  (orchestrator as any).agentStateCache.get("agent-1").sessionId = "session-stale";
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session:invalidate",
    agentId: "agent-1",
    sessionId: "session-stale",
    reason: "missing",
  });

  assert.deepEqual(orchestrator.invalidationCalls, [
    { agentId: "agent-1", sessionId: "session-stale", machineId: "machine-1" },
  ]);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").sessionId, null);
  assert.deepEqual(captured, [{
    room: "server:server-1",
    event: "agent:session",
    payload: { agentId: "agent-1", sessionId: null },
  }]);
  orchestrator.shutdown();
});

test("agent:session:invalidate preserves cache and broadcast when DB rejects session or machine ownership", async () => {
  const orchestrator = new SessionInvalidationDeterministicOrchestrator();
  orchestrator.invalidationApplied = false;
  const captured: Array<{ room: string; event: string; payload: unknown }> = [];
  (orchestrator as unknown as { io: ReturnType<typeof makeFakeServerIO> }).io = makeFakeServerIO(captured);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  (orchestrator as any).agentStateCache.get("agent-1").sessionId = "session-newer";
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session:invalidate",
    agentId: "agent-1",
    sessionId: "session-stale",
    reason: "missing",
  });

  assert.deepEqual(orchestrator.invalidationCalls, [
    { agentId: "agent-1", sessionId: "session-stale", machineId: "machine-1" },
  ]);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").sessionId, "session-newer");
  assert.deepEqual(captured, []);
  orchestrator.shutdown();
});

test("daemon ingress rate limit drops repeated session events before signal persistence", async () => {
  const clock = new FakeClock();
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new PersistTrackingDeterministicOrchestrator(undefined, clock, tracer);
  (orchestrator as any).daemonIngressRateLimitMaxEvents = 2;
  (orchestrator as any).daemonIngressRateLimitWindowMs = 1_000;
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-1",
  } as MachineToServerMessage);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-2",
  } as MachineToServerMessage);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-dropped",
  } as MachineToServerMessage);

  assert.deepEqual(orchestrator.persistCalls, [
    { source: "signal", status: "active", sessionId: "session-1" },
    { source: "signal", status: "active", sessionId: "session-2" },
  ]);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").sessionId, "session-2");

  const [dropSpan] = sink.getTrace(traceId).filter((span) => span.name === "server.daemon.ingress.rate_limit");
  assert.ok(dropSpan);
  assert.equal(dropSpan.attrs?.outcome, "dropped");
  assert.equal(dropSpan.attrs?.reason, "daemon_ingress_rate_limited");
  assert.equal(dropSpan.attrs?.machine_id, "machine-1");
  assert.equal(dropSpan.attrs?.server_id, "server-1");
  assert.equal(dropSpan.attrs?.agent_id, "agent-1");
  assert.equal(dropSpan.attrs?.scope, "message_type");
  assert.equal(dropSpan.attrs?.message_type, "agent:session");
  assert.equal(dropSpan.attrs?.limit, 2);
  assert.equal(dropSpan.attrs?.max_events, 2);
  assert.equal(dropSpan.attrs?.window_ms, 1_000);
  assert.equal(dropSpan.attrs?.dropped_count, 1);
  assert.equal(dropSpan.attrs?.retry_after_ms, 1_000);
  const rateLimitFact = traceSpanFactRowForSpanName(sink, traceId, "server.daemon.ingress.rate_limit");
  assert.equal(rateLimitFact.row_kind, "span_fact");
  assert.equal(rateLimitFact.event_name, "server.daemon.ingress.rate_limit");
  assert.equal(rateLimitFact.event_index, null);
  assert.equal(rateLimitFact.machine_id, "machine-1");
  assert.equal(rateLimitFact.server_id, "server-1");
  assert.equal(rateLimitFact.agent_id, "agent-1");
  assert.equal(rateLimitFact.outcome, "dropped");
  assert.equal(rateLimitFact.reason, "daemon_ingress_rate_limited");

  clock.advance(1_000);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-after-window",
  } as MachineToServerMessage);

  assert.deepEqual(orchestrator.persistCalls, [
    { source: "signal", status: "active", sessionId: "session-1" },
    { source: "signal", status: "active", sessionId: "session-2" },
    { source: "signal", status: "active", sessionId: "session-after-window" },
  ]);
  const spans = sink.getTrace(traceId).filter((span) => span.name === "server.daemon.ingress.rate_limit");
  assert.equal(spans.length, 2);
  assert.equal(spans[1]?.attrs?.outcome, "suppressed_aggregate");
  assert.equal(spans[1]?.attrs?.scope, "message_type");
  assert.equal(spans[1]?.attrs?.limit, 2);
  assert.equal(spans[1]?.attrs?.suppressed_count, 1);
  orchestrator.shutdown();
});

test("daemon ingress machine-total rate limit drops cross-type floods before per-type budget", async () => {
  const clock = new FakeClock();
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new PersistTrackingDeterministicOrchestrator(undefined, clock, tracer);
  (orchestrator as any).daemonIngressRateLimitMaxEvents = 10;
  (orchestrator as any).daemonIngressRateLimitMaxEventsPerMachine = 2;
  (orchestrator as any).daemonIngressRateLimitWindowMs = 1_000;
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-1",
  } as MachineToServerMessage);
  (orchestrator as any).agentStateCache.get("agent-1").status = "inactive";
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:status",
    agentId: "agent-1",
    status: "active",
  } as MachineToServerMessage);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-dropped-by-total",
  } as MachineToServerMessage);

  assert.deepEqual(orchestrator.persistCalls, [
    { source: "signal", status: "active", sessionId: "session-1" },
    { source: "signal", status: "active", sessionId: undefined },
  ]);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").sessionId, "session-1");

  const [dropSpan] = sink.getTrace(traceId).filter((span) => span.name === "server.daemon.ingress.rate_limit");
  assert.ok(dropSpan);
  assert.equal(dropSpan.attrs?.outcome, "dropped");
  assert.equal(dropSpan.attrs?.reason, "daemon_ingress_rate_limited");
  assert.equal(dropSpan.attrs?.scope, "machine_total");
  assert.equal(dropSpan.attrs?.message_type, undefined);
  assert.equal(dropSpan.attrs?.limit, 2);
  assert.equal(dropSpan.attrs?.max_events, 2);
  assert.equal(dropSpan.attrs?.dropped_count, 1);
  assert.equal(dropSpan.attrs?.retry_after_ms, 1_000);

  clock.advance(1_000);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-after-total-window",
  } as MachineToServerMessage);

  assert.deepEqual(orchestrator.persistCalls, [
    { source: "signal", status: "active", sessionId: "session-1" },
    { source: "signal", status: "active", sessionId: undefined },
    { source: "signal", status: "active", sessionId: "session-after-total-window" },
  ]);
  const spans = sink.getTrace(traceId).filter((span) => span.name === "server.daemon.ingress.rate_limit");
  assert.equal(spans.length, 2);
  assert.equal(spans[1]?.attrs?.outcome, "suppressed_aggregate");
  assert.equal(spans[1]?.attrs?.scope, "machine_total");
  assert.equal(spans[1]?.attrs?.message_type, undefined);
  assert.equal(spans[1]?.attrs?.limit, 2);
  assert.equal(spans[1]?.attrs?.suppressed_count, 1);
  orchestrator.shutdown();
});

test("daemon ingress rate limit is scoped by machine and event type", async () => {
  const clock = new FakeClock();
  const orchestrator = new PersistTrackingDeterministicOrchestrator(undefined, clock);
  (orchestrator as any).daemonIngressRateLimitMaxEvents = 1;
  (orchestrator as any).daemonIngressRateLimitWindowMs = 1_000;
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedActiveAgent(orchestrator, "agent-2", "machine-2");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  seedMachineConnection(orchestrator, "machine-2", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "machine-1-session-1",
  } as MachineToServerMessage);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "machine-1-session-dropped",
  } as MachineToServerMessage);
  await orchestrator.handleMachineMessage("machine-2", {
    type: "agent:session",
    agentId: "agent-2",
    sessionId: "machine-2-session-1",
  } as MachineToServerMessage);
  (orchestrator as any).agentStateCache.get("agent-1").status = "inactive";
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:status",
    agentId: "agent-1",
    status: "active",
  } as MachineToServerMessage);

  assert.deepEqual(orchestrator.persistCalls, [
    { source: "signal", status: "active", sessionId: "machine-1-session-1" },
    { source: "signal", status: "active", sessionId: "machine-2-session-1" },
    { source: "signal", status: "active", sessionId: undefined },
  ]);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").sessionId, "machine-1-session-1");
  assert.equal((orchestrator as any).agentStateCache.get("agent-2").sessionId, "machine-2-session-1");
  orchestrator.shutdown();
});

test("unchanged agent:session skips signal persistence", async () => {
  const orchestrator = new PersistTrackingDeterministicOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  (orchestrator as any).agentStateCache.get("agent-1").sessionId = "session-same";
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-same",
  } as MachineToServerMessage);

  assert.deepEqual(orchestrator.persistCalls, []);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").sessionId, "session-same");
  orchestrator.shutdown();
});

test("agent:session broadcasts session id to web clients", async () => {
  const orchestrator = new NoSessionBroadcastReloadOrchestrator();
  const captured: Array<{ room: string; event: string; payload: unknown }> = [];
  (orchestrator as unknown as { io: ReturnType<typeof makeFakeServerIO> }).io = makeFakeServerIO(captured);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-live",
  } as MachineToServerMessage);

  assert.deepEqual(captured, [
    {
      room: "server:server-1",
      event: "agent:session",
      payload: { agentId: "agent-1", sessionId: "session-live" },
    },
  ]);
  assert.equal(orchestrator.sessionBroadcastReloadCalls, 0);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").sessionId, "session-live");
  orchestrator.shutdown();
});

test("agent:session does not broadcast when signal DB guard rejects the write", async () => {
  const orchestrator = new SignalWriteRejectedDeterministicOrchestrator();
  const captured: Array<{ room: string; event: string; payload: unknown }> = [];
  (orchestrator as unknown as { io: ReturnType<typeof makeFakeServerIO> }).io = makeFakeServerIO(captured);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-rejected",
  } as MachineToServerMessage);

  assert.deepEqual(orchestrator.persistCalls, [
    { source: "signal", status: "active", sessionId: "session-rejected" },
  ]);
  assert.deepEqual(captured, []);
  assert.equal((orchestrator as any).agentStateCache.has("agent-1"), false);
  orchestrator.shutdown();
});

test("unchanged agent:status skips signal persistence", async () => {
  const orchestrator = new PersistTrackingDeterministicOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:status",
    agentId: "agent-1",
    status: "active",
  } as MachineToServerMessage);

  assert.deepEqual(orchestrator.persistCalls, []);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "active");
  orchestrator.shutdown();
});

test("agent:status active persist routes through the signal-protected API", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new PersistTrackingDeterministicOrchestrator(undefined, undefined, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  (orchestrator as any).agentStateCache.get("agent-1").status = "inactive";
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:status",
    agentId: "agent-1",
    status: "active",
  } as MachineToServerMessage);

  assert.deepEqual(orchestrator.persistCalls, [
    { source: "signal", status: "active", sessionId: undefined },
  ]);
  const statusSpan = sink.getTrace(traceId).find((span) => span.name === "server.agent.status.ingest");
  assert.ok(statusSpan);
  assert.equal(statusSpan.attrs?.agent_id_present, true);
  assert.equal(statusSpan.attrs?.machine_id_present, true);
  assert.equal(statusSpan.attrs?.agent_id, "agent-1");
  assert.equal(statusSpan.attrs?.machine_id, "machine-1");
  assert.equal(statusSpan.attrs?.server_id, "server-1");
  assert.equal(statusSpan.attrs?.reported_status, "active");
  assert.equal(statusSpan.attrs?.outcome, "persisted");
  assert.equal(statusSpan.attrs?.action, "persist-active");
  assert.equal(statusSpan.attrs?.next_status, "active");
  assert.equal(statusSpan.attrs?.live_activity_updated, false);
  const eventNames = eventsForSpan(sink, traceId, "server.agent.status.ingest").map((event) => event.name);
  assert.deepEqual(eventNames.slice(0, 3), [
    "agent.status.received",
    "agent.status.lifecycle_guard.checked",
    "agent.status.action.planned",
  ]);
  assert.equal(eventNames.includes("agent.lifecycle.event"), true);
  assert.equal(eventNames.filter((name) => name === "agent.lifecycle.projection").length, 4);
  assert.equal(eventNames.includes("agent.status.persisted"), true);
  assert.deepEqual(eventNames.slice(-1), [
    "agent.status.persisted",
  ]);
  const statusRows = traceEventRowsForSpanName(sink, traceId, "server.agent.status.ingest");
  const receivedRow = statusRows.find((row) => row.event_name === "agent.status.received");
  assert.ok(receivedRow);
  assert.equal(receivedRow.agent_id, "agent-1");
  assert.equal(receivedRow.machine_id, "machine-1");
  assert.equal(receivedRow.server_id, "server-1");
  assert.equal(receivedRow.outcome, "received");
  assert.equal(receivedRow.reason, "daemon_status");
  const persistedRow = statusRows.find((row) => row.event_name === "agent.status.persisted");
  assert.ok(persistedRow);
  assert.equal(persistedRow.agent_id, "agent-1");
  assert.equal(persistedRow.machine_id, "machine-1");
  assert.equal(persistedRow.server_id, "server-1");
  assert.equal(persistedRow.outcome, "persisted");
  assert.equal(persistedRow.reason, "status_signal");
  orchestrator.shutdown();
});

test("ready reconcile mark-active-online persist routes through the signal-protected API", async () => {
  const orchestrator = new PersistTrackingDeterministicOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  (orchestrator as any).agentStateCache.get("agent-1").status = "inactive";

  await (orchestrator as any).applyReadyReconcileAction(
    "machine-1",
    {
      id: "agent-1",
      status: "inactive",
      machineId: "machine-1",
    },
    "mark-active-online",
  );

  assert.deepEqual(orchestrator.persistCalls, [
    { source: "signal", status: "active", sessionId: undefined },
  ]);
  orchestrator.shutdown();
});

test("explicit startAgent projection persist still routes through the unguarded API", async () => {
  // The protected API blocks signal-driven resurrection, but explicit user
  // start (capability-checked, requested by the user) must still be allowed
  // to override stopped → active. Pin that the start reducer/writer does NOT
  // take the signal route.
  const orchestrator = new StartRoutingMismatchDeterministicOrchestrator();
  let explicitCalls = 0;
  let signalCalls = 0;
  (orchestrator as any).persistAgentStatus = async (_agentId: string, _status: DeterministicAgentStatus, _sessionId?: string) => {
    explicitCalls += 1;
  };
  (orchestrator as any).persistAgentStatusFromSignal = async (_agentId: string, _status: DeterministicAgentStatus, _sessionId?: string) => {
    signalCalls += 1;
    return true;
  };
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.startAgent("agent-1");

  assert.equal(explicitCalls, 1);
  assert.equal(signalCalls, 0);
  orchestrator.shutdown();
});

test("Kimi explicit reasoning rejects legacy daemon capability before fresh or resumed dispatch", async () => {
  for (const sessionId of [null, "persisted-session"] as const) {
    const orchestrator = new LegacyKimiCapabilityStartOrchestrator(sessionId);
    await assert.rejects(
      () => orchestrator.startAgent("agent-1"),
      (error: unknown) => {
        assert.ok(error instanceof KimiReasoningEffortUpgradeRequiredError);
        assert.equal(error.code, "upgrade_required");
        return true;
      },
    );
    assert.equal(
      orchestrator.startMessages.length,
      0,
      sessionId === null
        ? "fresh start must reject before dispatch"
        : "persisted resume must reject before dispatch",
    );
    orchestrator.shutdown();
  }
});

test("reset restart failure leaves the agent inactive rather than stuck in stopped", async () => {
  const orchestrator = new ResetFailureDeterministicOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");

  await orchestrator.resetAgent("agent-1", "restart");

  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "inactive");
  assert.deepEqual(
    orchestrator.sentToMachine.map((msg) => msg.type),
    ["agent:stop", "agent:start"],
  );
  assert.deepEqual(recentLifecycleEvents(orchestrator), [
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "reset",
      outcome: "attempted",
      cause: "restart",
      previousStatus: "active",
    },
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "stop",
      outcome: "completed",
      cause: "internal",
      previousStatus: "active",
      nextStatus: "inactive",
    },
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "start",
      outcome: "failed",
      cause: "manual",
      previousStatus: "inactive",
      detail: "Machine offline. Please start your local daemon.",
    },
    {
      agentId: "agent-1",
      machineId: "machine-1",
      action: "reset",
      outcome: "failed",
      cause: "restart",
      previousStatus: "active",
      nextStatus: "inactive",
    },
  ]);
  orchestrator.shutdown();
});

test("session reset can clear an inactive agent session without restarting", async () => {
  const orchestrator = new InactiveWindowDeliverMessageOrchestrator();
  const captured: Array<{ room: string; event: string; payload: unknown }> = [];
  (orchestrator as unknown as { io: ReturnType<typeof makeFakeServerIO> }).io = makeFakeServerIO(captured);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  (orchestrator as any).resetPersistedAgentSession = async () => {};
  (orchestrator as any).updateCache("agent-1", { status: "inactive", sessionId: "session-old" });

  await orchestrator.resetAgent("agent-1", "session", { restartEvenIfInactive: false });

  const cached = (orchestrator as any).agentStateCache.get("agent-1");
  assert.equal(cached.status, "inactive");
  assert.equal(cached.sessionId, null);
  assert.deepEqual(
    orchestrator.sentToMachine.map((msg) => msg.type),
    ["agent:stop"],
  );
  assert.deepEqual(captured, [
    {
      room: "server:server-1",
      event: "agent:session",
      payload: { agentId: "agent-1", sessionId: null },
    },
  ]);
  orchestrator.shutdown();
});

test("session reset can preserve an explicitly stopped agent without restarting", async () => {
  const orchestrator = new InactiveWindowDeliverMessageOrchestrator();
  const captured: Array<{ room: string; event: string; payload: unknown }> = [];
  (orchestrator as unknown as { io: ReturnType<typeof makeFakeServerIO> }).io = makeFakeServerIO(captured);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  (orchestrator as any).resetPersistedAgentSession = async () => {};
  (orchestrator as any).updateCache("agent-1", { status: "stopped", sessionId: "session-old" });

  await orchestrator.resetAgent("agent-1", "session", { restartIfStopped: false });

  const cached = (orchestrator as any).agentStateCache.get("agent-1");
  assert.equal(cached.status, "stopped");
  assert.equal(cached.sessionId, null);
  assert.deepEqual(
    orchestrator.sentToMachine.map((msg) => msg.type),
    ["agent:stop"],
  );
  assert.deepEqual(captured, [
    {
      room: "server:server-1",
      event: "agent:session",
      payload: { agentId: "agent-1", sessionId: null },
    },
  ]);
  orchestrator.shutdown();
});

test("session reset does not let a late message wake the agent with a stale session", async () => {
  const orchestrator = new DeferredResetWindowOrchestrator();
  const message = makeAgentMessage("message during session reset");

  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  (orchestrator as any).agentStateCache.get("agent-1").sessionId = "session-old";

  const resetPromise = orchestrator.resetAgent("agent-1", "session");
  await flushMicrotasks();
  assert.equal(orchestrator.inactivePersistEntered, true);
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "inactive");

  await orchestrator.deliverMessage("agent-1", message);
  orchestrator.inactivePersistGate.resolve();
  await resetPromise;

  const startMessages = orchestrator.sentToMachine.filter((msg) => msg.type === "agent:start");
  assert.equal(startMessages.length, 1);
  assert.equal(startMessages[0]?.config.sessionId, null);

  orchestrator.shutdown();
});

// --- Server-side heartbeat timeout state machine ---

test("heartbeat tick pings at 30s and times out only after the 60s threshold is exceeded", async () => {
  const clock = new FakeClock();
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new HeartbeatDeterministicAgentOrchestrator(store, clock);
  const ws = makeFakeWs(1);
  const conn = seedMachineConnection(orchestrator, "machine-1", ws);
  seedActiveAgent(orchestrator);
  store.machineReplicas.add("machine-1");
  conn.lastPong = clock.now();
  startHeartbeat(orchestrator, "machine-1", conn);

  clock.advance(30_000);
  assert.equal(ws.sent.length, 1);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });

  clock.advance(30_000);
  assert.equal(ws.terminated, 0);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });

  clock.advance(30_000);
  assert.equal(ws.terminated, 1);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "" });

  orchestrator.shutdown();
});

test("pong before the timeout threshold resets the server-side heartbeat deadline", async () => {
  const clock = new FakeClock();
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new HeartbeatDeterministicAgentOrchestrator(store, clock);
  const ws = makeFakeWs(1);
  const conn = seedMachineConnection(orchestrator, "machine-1", ws);
  seedActiveAgent(orchestrator);
  store.machineReplicas.add("machine-1");
  conn.lastPong = clock.now();
  startHeartbeat(orchestrator, "machine-1", conn);

  clock.advance(59_000);
  await orchestrator.handleMachineMessage("machine-1", { type: "pong" } as MachineToServerMessage);

  clock.advance(31_000);
  assert.equal(ws.terminated, 0);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });

  clock.advance(30_000);
  assert.equal(ws.terminated, 1);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "" });

  orchestrator.shutdown();
});

test("accepted non-pong daemon ingress keeps heartbeat projection live when pong is missing", async () => {
  const clock = new FakeClock();
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new HeartbeatDeterministicAgentOrchestrator(store, clock);
  const ws = makeFakeWs(1);
  const conn = seedMachineConnection(orchestrator, "machine-1", ws);
  seedActiveAgent(orchestrator, "agent-1", "machine-1", "codex");
  store.machineReplicas.add("machine-1");
  conn.lastPong = clock.now();
  conn.lastIngressAt = clock.now();
  startHeartbeat(orchestrator, "machine-1", conn);

  clock.advance(59_000);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "Running tests",
    detailKind: "running_command",
    entries: [{ kind: "status", activity: "working", activityKind: "working", detail: "Running tests", detailKind: "running_command" }],
    launchId: "launch-working",
    clientSeq: 1,
    observedAtMs: clock.now(),
  } as MachineToServerMessage);

  clock.advance(31_000);
  assert.equal(ws.terminated, 0);
  assert.equal((orchestrator as any).machineConnections.has("machine-1"), true);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "working", activityDetail: "Running tests" });

  clock.advance(30_001);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ws.terminated, 1, "the heartbeat still times out once both pong and daemon ingress go stale");
  assert.equal((orchestrator as any).machineConnections.has("machine-1"), false);

  orchestrator.shutdown();
});

test("stale heartbeat timeout from an old connection does not disconnect the replacement connection", async () => {
  const clock = new FakeClock();
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new HeartbeatDeterministicAgentOrchestrator(store, clock);
  const oldWs = makeFakeWs(1);
  const newWs = makeFakeWs(1);
  const oldConn = seedMachineConnection(orchestrator, "machine-1", oldWs);
  seedActiveAgent(orchestrator);
  store.machineReplicas.add("machine-1");
  oldConn.lastPong = clock.now();
  startHeartbeat(orchestrator, "machine-1", oldConn);

  // Simulate reconnect: new connection replaces the old one before the old timeout fires.
  const newConn = seedMachineConnection(orchestrator, "machine-1", newWs);
  newConn.lastPong = clock.now();

  clock.advance(61_000);

  assert.equal(((orchestrator as any).machineConnections.get("machine-1")?.ws), newWs);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });

  orchestrator.shutdown();
});

test("buggy stale heartbeat timeout semantics would disconnect the replacement connection", async () => {
  const clock = new FakeClock();
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new BuggyHeartbeatTimeoutOrchestrator(store, clock);
  const oldWs = makeFakeWs(1);
  const newWs = makeFakeWs(1);
  const oldConn = seedMachineConnection(orchestrator, "machine-1", oldWs);
  seedActiveAgent(orchestrator);
  store.machineReplicas.add("machine-1");
  oldConn.lastPong = clock.now();
  startHeartbeat(orchestrator, "machine-1", oldConn);

  const newConn = seedMachineConnection(orchestrator, "machine-1", newWs);
  newConn.lastPong = clock.now();

  clock.advance(61_000);

  assert.equal((orchestrator as any).machineConnections.has("machine-1"), false);
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "offline", activityDetail: "" });

  orchestrator.shutdown();
});

// --- Wake lock / duplicate start guard ---

test("configured Wiki Agent uses a fail-closed start type and carries the Server-pinned exact pack", async () => {
  const orchestrator = new WikiPackStartDeterministicAgentOrchestrator(
    new InMemoryReplicaStateStore(),
  );
  // Deliberately omit the live capability. Setup requires it, while later
  // cross-replica starts remain safe because old daemons ignore this new type.
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs(), "99.0.0");

  await orchestrator.startAgent("agent-1");
  assert.equal(orchestrator.startMessages.length, 0);
  assert.equal(orchestrator.wikiStartMessages.length, 1);
  assert.deepEqual(orchestrator.wikiStartMessages[0]?.wikiWorkspacePack, WIKI_AGENT_WORKSPACE_PACK);
  orchestrator.shutdown();
});

test("wake lock blocks a second sequential start until startup completion releases the lease", async () => {
  const store = new InMemoryReplicaStateStore();
  const replicaA = new WakeLockDeterministicAgentOrchestrator(store);
  const replicaB = new WakeLockDeterministicAgentOrchestrator(store);

  const first = await replicaA.startAgent("agent-1");
  const second = await replicaB.startAgent("agent-1");

  assert.deepEqual(first, { outcome: "dispatched" });
  assert.deepEqual(second, { outcome: "skipped", reason: "wake_lock_held" });
  assert.equal(replicaA.startMessages.length + replicaB.startMessages.length, 1);
  assert.equal(store.wakeLocks.size, 1);

  replicaA.shutdown();
  replicaB.shutdown();
});

test("deliverMessage retains a second replica wake message when the wake lock is already held", async () => {
  const store = new InMemoryReplicaStateStore();
  const replicaA = new WakeLockDeterministicAgentOrchestrator(store);
  const replicaB = new WakeLockDeterministicAgentOrchestrator(store);
  const firstMessage = makeAgentMessage("first wake message", 1);
  const secondMessage = makeAgentMessage("second wake message", 2);
  const receiptRequiredMessage = makeAgentMessage("strict wake message", 3);

  seedActiveAgent(replicaA);
  seedActiveAgent(replicaB);
  (replicaA as any).agentStateCache.get("agent-1").status = "inactive";
  (replicaB as any).agentStateCache.get("agent-1").status = "inactive";

  const first = await replicaA.deliverMessage("agent-1", firstMessage);
  const second = await replicaB.deliverMessage("agent-1", secondMessage);
  const receiptRequired = await replicaB.deliverMessage(
    "agent-1",
    receiptRequiredMessage,
    { requireQueueReceipt: true },
  );

  assert.deepEqual(first, { status: "queued", reason: "wake_accepted" });
  assert.deepEqual(second, { status: "queued", reason: "replayable_inbox" });
  assert.deepEqual(receiptRequired, { status: "dropped", reason: "cross_replica_receipt_unavailable" });
  assert.equal(replicaA.startMessages.length + replicaB.startMessages.length, 1);
  assert.deepEqual(replicaA.startMessages[0]?.wakeMessage, firstMessage);
  assert.deepEqual((replicaA as any).agentInboxes.get("agent-1")?.inbox ?? [], []);
  assert.deepEqual((replicaB as any).agentInboxes.get("agent-1")?.inbox ?? [], [secondMessage]);

  replicaA.shutdown();
  replicaB.shutdown();
});

test("buggy wake-lock semantics would allow the same concurrent scenario to double-start", async () => {
  const store = new BuggyWakeLockStore();
  const holdFirstSend = deferred<void>();
  const firstSendEntered = deferred<void>();

  const replicaA = new WakeLockDeterministicAgentOrchestrator(store, {
    holdSend: holdFirstSend.promise,
    onSend: () => firstSendEntered.resolve(),
  });
  const replicaB = new WakeLockDeterministicAgentOrchestrator(store);

  const firstStart = replicaA.startAgent("agent-1");
  await firstSendEntered.promise;

  const secondStart = replicaB.startAgent("agent-1");
  await Promise.resolve();

  holdFirstSend.resolve();
  await Promise.all([firstStart, secondStart]);

  assert.equal(replicaA.startMessages.length + replicaB.startMessages.length, 2);

  replicaA.shutdown();
  replicaB.shutdown();
});

test("wake lock is released after a failed start so a later retry can proceed", async () => {
  const store = new InMemoryReplicaStateStore();
  const failingReplica = new WakeLockDeterministicAgentOrchestrator(store, { sendSucceeds: false });
  const retryReplica = new WakeLockDeterministicAgentOrchestrator(store);

  await assert.rejects(() => failingReplica.startAgent("agent-1"), /Machine offline/);
  assert.equal(store.wakeLocks.size, 0);

  await retryReplica.startAgent("agent-1");
  assert.equal(retryReplica.startMessages.length, 1);

  failingReplica.shutdown();
  retryReplica.shutdown();
});

test("startup completion releases the wake lock and allows a later start", async () => {
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new WakeLockDeterministicAgentOrchestrator(store);
  seedMachineConnection(orchestrator, "machine-1", {});

  await orchestrator.startAgent("agent-1");
  assert.equal(store.wakeLocks.size, 1);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-1",
  } as MachineToServerMessage);

  assert.equal(store.wakeLocks.size, 0);

  await orchestrator.startAgent("agent-1");
  assert.equal(orchestrator.startMessages.length, 2);

  orchestrator.shutdown();
});

test("resume catchup prepare span fact promotes agent machine server session on query failure", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new ResumeCatchupTraceDeterministicOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);
  seedMachineConnection(orchestrator, "machine-1", {});

  await orchestrator.startAgent("agent-1");

  assert.equal(orchestrator.startMessages.length, 1);
  const resumeRows = traceEventRowsForSpanName(sink, traceId, "server.agent.resume_catchup.prepare");
  const failedRow = resumeRows.find((row) => row.event_name === "resume_catchup.failed");
  assert.ok(failedRow);
  assert.equal(failedRow.agent_id, "agent-1");
  assert.equal(failedRow.machine_id, "machine-1");
  assert.equal(failedRow.server_id, "server-1");
  assert.equal(failedRow.session_id, "session-1");
  assert.equal(failedRow.outcome, "failed");
  assert.equal(failedRow.reason, "query_failed");
  const fact = traceSpanFactRowForSpanName(sink, traceId, "server.agent.resume_catchup.prepare");
  assert.equal(fact.row_kind, "span_fact");
  assert.equal(fact.agent_id, "agent-1");
  assert.equal(fact.machine_id, "machine-1");
  assert.equal(fact.server_id, "server-1");
  assert.equal(fact.session_id, "session-1");
  assert.equal(fact.outcome, "failed");
  assert.equal(fact.reason, "query_failed");

  orchestrator.shutdown();
});

test("manual stop releases the wake lock even before startup confirmation arrives", async () => {
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new WakeLockDeterministicAgentOrchestrator(store);
  seedMachineConnection(orchestrator, "machine-1", {});

  await orchestrator.startAgent("agent-1");
  assert.equal(store.wakeLocks.size, 1);

  await orchestrator.stopAgent("agent-1");
  assert.equal(store.wakeLocks.size, 0);

  orchestrator.shutdown();
});

test("agent session resolves optimistic starting activity back to online", async () => {
  const orchestrator = new LaunchGuardDeterministicAgentOrchestrator();
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.startAgent("agent-1");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "working", activityDetail: "Starting\u2026" });

  const launchId = orchestrator.startMessages.at(-1)?.launchId;
  assert.ok(launchId);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-1",
    launchId,
  });

  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });

  orchestrator.shutdown();
});

test("guarded startup session resolves starting even while a reset window is closing", async () => {
  const orchestrator = new LaunchGuardDeterministicAgentOrchestrator();
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.startAgent("agent-1");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "working", activityDetail: "Starting\u2026" });

  const launchId = orchestrator.startMessages.at(-1)?.launchId;
  assert.ok(launchId);
  (orchestrator as any).resetInProgress.set("agent-1", "session");

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-1",
    launchId,
  });

  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });

  orchestrator.shutdown();
});

test("agent status active also resolves optimistic starting activity back to online", async () => {
  const orchestrator = new LaunchGuardDeterministicAgentOrchestrator();
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.startAgent("agent-1");
  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "working", activityDetail: "Starting\u2026" });

  const launchId = orchestrator.startMessages.at(-1)?.launchId;
  assert.ok(launchId);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:status",
    agentId: "agent-1",
    status: "active",
    launchId,
  });

  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });

  orchestrator.shutdown();
});

test("startup confirmation does not overwrite a real post-start working activity", async () => {
  const orchestrator = new LaunchGuardDeterministicAgentOrchestrator();
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.startAgent("agent-1");
  const launchId = orchestrator.startMessages.at(-1)?.launchId;
  assert.ok(launchId);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "Compiling prompt",
    launchId,
  });
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:session",
    agentId: "agent-1",
    sessionId: "session-1",
    launchId,
  });

  assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "working", activityDetail: "Compiling prompt" });

  orchestrator.shutdown();
});

// --- Local stale-activity sweep semantics ---

test("stale working activity remains unchanged when the 90-second sweep has no replacement observation", () => {
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore());
  const updatedAt = Date.now() - 91_000;
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "stuck",
    detailKind: "other",
    updatedAt,
  });

  (orchestrator as any).sweepStaleActivities();

  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), {
    activity: "working",
    detail: "stuck",
    detailKind: "other",
    updatedAt,
  });
  orchestrator.shutdown();
});

test("stale sweep reads observedAtMs instead of the activity write clock", () => {
  const { sink, tracer } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(120_000);
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), clock, tracer);
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "stuck with fresh mirror write",
    detailKind: "other",
    observedAtMs: clock.now() - 91_000,
    updatedAt: clock.now(),
  });

  (orchestrator as any).sweepStaleActivities();

  assert.equal(
    sink.getAllSpans().filter((span) => span.name === "server.agent.synthetic_repair.apply").length,
    1,
    "stale observedAtMs must trigger the diagnostic even when the write clock is fresh",
  );
  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), {
    activity: "working",
    detail: "stuck with fresh mirror write",
    detailKind: "other",
    observedAtMs: clock.now() - 91_000,
    updatedAt: clock.now(),
  });
  orchestrator.shutdown();
});

test("stale sweep preserves busy activity when the machine is live on another replica (#448)", async () => {
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  const clock = new FakeClock();
  clock.advance(120_000);
  const orchestrator = new DeterministicAgentOrchestrator(store, clock);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  const broadcasts = captureSweepBroadcasts(orchestrator);
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "Long tool call",
    detailKind: "running_command",
    updatedAt: clock.now() - 91_000,
  });

  (orchestrator as any).sweepStaleActivities();
  await flushMicrotasks(5);

  assert.deepEqual(broadcasts, [], "remote-owner preservation must not mint a synthetic user activity fact");
  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), {
    activity: "working",
    detail: "Long tool call",
    detailKind: "running_command",
    updatedAt: clock.now() - 91_000,
  });
  orchestrator.shutdown();
});

test("stale sweep preserves busy activity for a stale self-owned mapping when no observation can replace it (#448, task #499)", async () => {
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  store.machineReplicaOwners.set("machine-1", REPLICA_ID);
  const clock = new FakeClock();
  clock.advance(120_000);
  const orchestrator = new DeterministicAgentOrchestrator(store, clock);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "stale self-owned",
    detailKind: "running_command",
    updatedAt: clock.now() - 91_000,
  });

  (orchestrator as any).sweepStaleActivities();
  await flushMicrotasks(5);

  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), {
    activity: "working",
    detail: "stale self-owned",
    detailKind: "running_command",
    updatedAt: clock.now() - 91_000,
  });
  orchestrator.shutdown();
});

test("applyStaleActivitySweepAction keeps stale activity truth without scheduling a broadcast", () => {
  const orchestrator = new StaleActivityApplyDeterministicOrchestrator();
  const now = Date.now();
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "stuck",
    detailKind: "other",
    observedAtMs: now - 95_000,
    updatedAt: now - 91_000,
  });

  orchestrator.callApplyStaleActivitySweepAction("sweep-online", "agent-1", now);

  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), {
    activity: "working",
    detail: "stuck",
    detailKind: "other",
    observedAtMs: now - 95_000,
    updatedAt: now - 91_000,
  });
  assert.equal((orchestrator as any).activityDebounceTimers.has("agent-1"), false);
  orchestrator.shutdown();
});

test("fresh working activity is not swept before the stale threshold", () => {
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore());
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "still-fresh",
    detailKind: "other",
    updatedAt: Date.now() - 30_000,
  });

  (orchestrator as any).sweepStaleActivities();

  assert.equal((orchestrator as any).agentActivity.get("agent-1").activity, "working");
  orchestrator.shutdown();
});

test("applyStaleActivitySweepAction keeps current activity on keep-current", () => {
  const orchestrator = new StaleActivityApplyDeterministicOrchestrator();
  const now = Date.now();
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "still-fresh",
    detailKind: "other",
    updatedAt: now - 30_000,
  });

  orchestrator.callApplyStaleActivitySweepAction("keep-current", "agent-1", now);

  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), {
    activity: "working",
    detail: "still-fresh",
    detailKind: "other",
    updatedAt: now - 30_000,
  });
  assert.equal((orchestrator as any).activityDebounceTimers.has("agent-1"), false);
  orchestrator.shutdown();
});

// --- Synthetic repair lifecycle trace ---

test("applyStaleActivitySweepAction is diagnostic-only and closes without lifecycle projections", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const orchestrator = new SyntheticRepairFactDeterministicOrchestrator(persistedLogs, undefined, tracer);
  const now = Date.now();
  (orchestrator as any).agentStateCache.set("agent-1", { serverId: "server-1" });
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "stuck",
    detailKind: "other",
    observedAtMs: now - 95_000,
    updatedAt: now - 91_000,
  });

  orchestrator.callApplyStaleActivitySweepAction("sweep-online", "agent-1", now);
  await flushMicrotasks(10);

  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [], "stale sweep must not persist a fact");
  assert.deepEqual(orchestrator.emittedActivityPayloads, [], "stale sweep must not emit a user activity");
  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), {
    activity: "working",
    detail: "stuck",
    detailKind: "other",
    observedAtMs: now - 95_000,
    updatedAt: now - 91_000,
  });
  const spans = sink.getTrace(traceId).filter((s) => s.name === "server.agent.synthetic_repair.apply");
  assert.equal(spans.length, 1, "should emit exactly one synthetic repair span");
  const span = spans[0];
  assert.equal(span.attrs?.repair_kind, "stale_sweep");
  assert.equal(span.attrs?.synthetic_repair, true);
  assert.equal(span.attrs?.authority, "scheduler_repair");
  assert.equal(span.attrs?.previous_activity, "working");
  assert.equal(span.attrs?.candidate_activity, "online");
  assert.equal(span.attrs?.served_activity, "working");
  assert.equal(span.attrs?.projection_outcome, "preserved_without_write");
  assert.equal(span.attrs?.advances_observed_clock, "none");
  const eventNames = span.events.map((e) => e.name);
  assert.ok(eventNames.includes("lifecycle_v2.shadow_verdict"), "span retains the rejected legacy candidate verdict");
  assert.equal(eventNames.includes("agent.lifecycle.event"), false);
  assert.equal(eventNames.includes("agent.lifecycle.projection"), false);
  orchestrator.shutdown();
});

test("applyStaleTransientNormalizationAction serves an ephemeral view without lifecycle projections", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const orchestrator = new SyntheticRepairFactDeterministicOrchestrator(persistedLogs, undefined, tracer);
  const now = Date.now();
  (orchestrator as any).agentStateCache.set("agent-1", { serverId: "server-1" });
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "stuck",
    detailKind: "other",
    observedAtMs: now - 95_000,
    updatedAt: now - 91_000,
  });

  const served = orchestrator.callApplyStaleTransientNormalizationAction("normalize-online", "agent-1", "local-cache", now);
  await flushMicrotasks(10);

  assert.deepEqual(served, { activity: "online", activityDetail: "" });
  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [], "read normalization must not persist a fact");
  assert.deepEqual(orchestrator.emittedActivityPayloads, [], "read normalization must not emit a user activity");
  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), {
    activity: "working",
    detail: "stuck",
    detailKind: "other",
    observedAtMs: now - 95_000,
    updatedAt: now - 91_000,
  });
  const spans = sink.getTrace(traceId).filter((s) => s.name === "server.agent.synthetic_repair.apply");
  assert.equal(spans.length, 1, "should emit exactly one synthetic repair span");
  const span = spans[0];
  assert.equal(span.attrs?.repair_kind, "transient_normalization");
  assert.equal(span.attrs?.synthetic_repair, true);
  assert.equal(span.attrs?.authority, "scheduler_repair");
  assert.equal(span.attrs?.previous_activity, "working");
  assert.equal(span.attrs?.candidate_activity, "online");
  assert.equal(span.attrs?.served_activity, "online");
  assert.equal(span.attrs?.projection_outcome, "served_ephemeral");
  assert.equal(span.attrs?.advances_observed_clock, "none");
  const eventNames = span.events.map((e) => e.name);
  assert.ok(eventNames.includes("lifecycle_v2.shadow_verdict"), "span retains the rejected legacy candidate verdict");
  assert.equal(eventNames.includes("agent.lifecycle.event"), false);
  assert.equal(eventNames.includes("agent.lifecycle.projection"), false);
  orchestrator.shutdown();
});

// --- Writer helper observability (A3) ---

test("broadcastReadyOnline adds ready_online.resolve trace event on broadcast", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new ReadyReconcileDeterministicOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  (orchestrator as any).updateCache("agent-1", { status: "inactive" });

  const span = tracer.startSpan("test.ready_reconcile", { surface: "server", kind: "internal" });
  await orchestrator.callApplyReadyReconcileAction("machine-1", "agent-1", "mark-active-online", span);
  span.end("ok");
  await flushMicrotasks();

  const spans = sink.getTrace(traceId);
  const readyEvent = spans
    .flatMap((s) => s.events)
    .find((e) => e.name === "ready_online.resolve");
  assert.ok(readyEvent, "span must contain ready_online.resolve event");
  assert.equal(readyEvent.attrs?.outcome, "broadcast");
  assert.equal(readyEvent.attrs?.agent_id, "agent-1");
  const [readyResolveRow] = traceEventRowsForSpanName(sink, traceId, "test.ready_reconcile")
    .filter((row) => row.event_name === "ready_online.resolve");
  assert.ok(readyResolveRow);
  assert.equal(readyResolveRow.agent_id, "agent-1");
  assert.equal(readyResolveRow.outcome, "broadcast");
  orchestrator.shutdown();
});

test("broadcastReadyOnline adds skip trace event when fresh busy activity present", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(5_000);
  const orchestrator = new ReadyReconcileDeterministicOrchestrator(new InMemoryReplicaStateStore(), clock, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "Editing file…",
    detailKind: "other",
    updatedAt: clock.now() - 5_000,
  });

  const span = tracer.startSpan("test.ready_reconcile", { surface: "server", kind: "internal" });
  await orchestrator.callApplyReadyReconcileAction("machine-1", "agent-1", "mark-active-online", span);
  span.end("ok");
  await flushMicrotasks();

  const spans = sink.getTrace(traceId);
  const readyEvent = spans
    .flatMap((s) => s.events)
    .find((e) => e.name === "ready_online.resolve");
  assert.ok(readyEvent, "span must contain ready_online.resolve event");
  assert.equal(readyEvent.attrs?.outcome, "skip");
  assert.equal(readyEvent.attrs?.reason, "fresh_busy_cached");
  orchestrator.shutdown();
});

test("maybeResolveStartingActivity adds resolved trace event when Starting… is resolved", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new ReadyReconcileDeterministicOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "Starting…",
    detailKind: "starting",
    updatedAt: Date.now(),
  });

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:status",
    agentId: "agent-1",
    status: "active",
    launchId: "launch-1",
  } as MachineToServerMessage);
  await flushMicrotasks();

  const spans = sink.getTrace(traceId);
  const resolveEvent = spans
    .flatMap((s) => s.events)
    .find((e) => e.name === "starting_activity.resolve");
  assert.ok(resolveEvent, "span must contain starting_activity.resolve event");
  assert.equal(resolveEvent.attrs?.outcome, "resolved");
  assert.equal(resolveEvent.attrs?.reason, "starting_activity_snapshot");
  const [resolveRow] = traceEventRowsForSpanName(sink, traceId, "server.agent.status.ingest")
    .filter((row) => row.event_name === "starting_activity.resolve");
  assert.ok(resolveRow);
  assert.equal(resolveRow.agent_id, "agent-1");
  assert.equal(resolveRow.machine_id, "machine-1");
  assert.equal(resolveRow.server_id, "server-1");
  assert.equal(resolveRow.launch_id, "launch-1");
  assert.equal(resolveRow.outcome, "resolved");
  assert.equal(resolveRow.reason, "starting_activity_snapshot");
  orchestrator.shutdown();
});

test("maybeResolveStartingActivity adds skip trace event when activity is not Starting…", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new ReadyReconcileDeterministicOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "Editing file…",
    detailKind: "other",
    updatedAt: Date.now(),
  });

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:status",
    agentId: "agent-1",
    status: "active",
    launchId: "launch-1",
  } as MachineToServerMessage);
  await flushMicrotasks();

  const spans = sink.getTrace(traceId);
  const resolveEvent = spans
    .flatMap((s) => s.events)
    .find((e) => e.name === "starting_activity.resolve");
  assert.ok(resolveEvent, "span must contain starting_activity.resolve event");
  assert.equal(resolveEvent.attrs?.outcome, "skip");
  assert.equal(resolveEvent.attrs?.reason, "not_starting_detail");
  const [resolveRow] = traceEventRowsForSpanName(sink, traceId, "server.agent.status.ingest")
    .filter((row) => row.event_name === "starting_activity.resolve");
  assert.ok(resolveRow);
  assert.equal(resolveRow.agent_id, "agent-1");
  assert.equal(resolveRow.machine_id, "machine-1");
  assert.equal(resolveRow.server_id, "server-1");
  assert.equal(resolveRow.launch_id, "launch-1");
  assert.equal(resolveRow.outcome, "skip");
  assert.equal(resolveRow.reason, "not_starting_detail");
  orchestrator.shutdown();
});

test("broadcastReadyOnline adds skip trace event when fresh busy activity is persisted but not cached", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(100_000);
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  persistedLogs.set("agent-1", [{
    timestamp: clock.now() - 5_000,
    entry: { kind: "status", activity: "working", detail: "Editing file…" },
  }]);
  const orchestrator = new ReadyReconcileActivityLogDeterministicOrchestrator(persistedLogs, clock, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const span = tracer.startSpan("test.ready_reconcile", { surface: "server", kind: "internal" });
  await orchestrator.callApplyReadyReconcileAction("machine-1", "agent-1", "mark-active-online", span);
  span.end("ok");
  await flushMicrotasks();

  const spans = sink.getTrace(traceId);
  const readyEvent = spans
    .flatMap((s) => s.events)
    .find((e) => e.name === "ready_online.resolve");
  assert.ok(readyEvent, "span must contain ready_online.resolve event");
  assert.equal(readyEvent.attrs?.outcome, "skip");
  assert.equal(readyEvent.attrs?.reason, "fresh_busy_persisted");
  assert.equal(readyEvent.attrs?.persisted_activity, "working");
  const projectionEvents = spans.flatMap((s) => s.events).filter((e) => e.name === "agent.lifecycle.projection");
  assert.ok(projectionEvents.length >= 4, "lifecycle projection rows must be in the same span");
  orchestrator.shutdown();
});

test("broadcastReadyOnline does not overwrite persisted runtime error state", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(100_000);
  const orchestrator = new ReadyReconcileDeterministicOrchestrator(new InMemoryReplicaStateStore(), clock, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  (orchestrator as any).updateCache("agent-1", {
    lastRuntimeError: {
      message: "Built-in provider authentication failed",
      at: new Date(clock.now() - 120_000).toISOString(),
      launchId: "launch-auth",
      actionRequired: true,
    },
  });

  const span = tracer.startSpan("test.ready_reconcile", { surface: "server", kind: "internal" });
  await orchestrator.callApplyReadyReconcileAction("machine-1", "agent-1", "mark-active-online", span);
  span.end("ok");
  await flushMicrotasks();

  assert.deepEqual(await orchestrator.getActivity("agent-1"), {
    activity: "error",
    activityDetail: "Built-in provider authentication failed",
  });
  const readyEvent = sink.getTrace(traceId)
    .flatMap((s) => s.events)
    .find((e) => e.name === "ready_online.resolve");
  assert.ok(readyEvent, "span must contain ready_online.resolve event");
  assert.equal(readyEvent.attrs?.outcome, "skip");
  assert.equal(readyEvent.attrs?.reason, "runtime_error_state");
  orchestrator.shutdown();
});

test("broadcastReadyOnline emits has_trajectory_entry=true when previous activity is durable recovery", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new ReadyReconcileDeterministicOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  (orchestrator as any).updateCache("agent-1", { status: "inactive" });

  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "offline",
    detail: "",
    detailKind: "none",
    updatedAt: Date.now(),
  });

  const span = tracer.startSpan("test.ready_reconcile", { surface: "server", kind: "internal" });
  await orchestrator.callApplyReadyReconcileAction("machine-1", "agent-1", "mark-active-online", span);
  span.end("ok");
  await flushMicrotasks();

  const spans = sink.getTrace(traceId);
  const readyEvent = spans
    .flatMap((s) => s.events)
    .find((e) => e.name === "ready_online.resolve");
  assert.ok(readyEvent, "span must contain ready_online.resolve event");
  assert.equal(readyEvent.attrs?.outcome, "broadcast");
  assert.equal(readyEvent.attrs?.previous_activity, "offline");
  assert.equal(readyEvent.attrs?.has_trajectory_entry, true);
  const projectionEvents = spans.flatMap((s) => s.events).filter((e) => e.name === "agent.lifecycle.projection");
  assert.ok(projectionEvents.length >= 4, "lifecycle projection rows must be in the same span");
  orchestrator.shutdown();
});

test("maybeResolveStartingActivity adds skip trace event when no current activity exists", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new ReadyReconcileDeterministicOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:status",
    agentId: "agent-1",
    status: "active",
    launchId: "launch-1",
  } as MachineToServerMessage);
  await flushMicrotasks();

  const spans = sink.getTrace(traceId);
  const resolveEvent = spans
    .flatMap((s) => s.events)
    .find((e) => e.name === "starting_activity.resolve");
  assert.ok(resolveEvent, "span must contain starting_activity.resolve event");
  assert.equal(resolveEvent.attrs?.outcome, "skip");
  assert.equal(resolveEvent.attrs?.reason, "no_current_activity");
  const [resolveRow] = traceEventRowsForSpanName(sink, traceId, "server.agent.status.ingest")
    .filter((row) => row.event_name === "starting_activity.resolve");
  assert.ok(resolveRow);
  assert.equal(resolveRow.agent_id, "agent-1");
  assert.equal(resolveRow.machine_id, "machine-1");
  assert.equal(resolveRow.server_id, "server-1");
  assert.equal(resolveRow.launch_id, "launch-1");
  assert.equal(resolveRow.outcome, "skip");
  assert.equal(resolveRow.reason, "no_current_activity");
  const projectionEvents = spans.flatMap((s) => s.events).filter((e) => e.name === "agent.lifecycle.projection");
  assert.ok(projectionEvents.length >= 4, "lifecycle projection rows must be in the same span");
  orchestrator.shutdown();
});

test("maybeResolveStartingActivity adds skip trace event with current_activity when activity is not working", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new ReadyReconcileDeterministicOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "online",
    detail: "",
    detailKind: "none",
    updatedAt: Date.now(),
  });

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:status",
    agentId: "agent-1",
    status: "active",
    launchId: "launch-1",
  } as MachineToServerMessage);
  await flushMicrotasks();

  const spans = sink.getTrace(traceId);
  const resolveEvent = spans
    .flatMap((s) => s.events)
    .find((e) => e.name === "starting_activity.resolve");
  assert.ok(resolveEvent, "span must contain starting_activity.resolve event");
  assert.equal(resolveEvent.attrs?.outcome, "skip");
  assert.equal(resolveEvent.attrs?.reason, "not_working");
  assert.equal(resolveEvent.attrs?.current_activity, "online");
  const [resolveRow] = traceEventRowsForSpanName(sink, traceId, "server.agent.status.ingest")
    .filter((row) => row.event_name === "starting_activity.resolve");
  assert.ok(resolveRow);
  assert.equal(resolveRow.agent_id, "agent-1");
  assert.equal(resolveRow.machine_id, "machine-1");
  assert.equal(resolveRow.server_id, "server-1");
  assert.equal(resolveRow.launch_id, "launch-1");
  assert.equal(resolveRow.outcome, "skip");
  assert.equal(resolveRow.reason, "not_working");
  const projectionEvents = spans.flatMap((s) => s.events).filter((e) => e.name === "agent.lifecycle.projection");
  assert.ok(projectionEvents.length >= 4, "lifecycle projection rows must be in the same span");
  orchestrator.shutdown();
});

// --- Concurrent receiveMessages semantics ---

test("a newer blocked receive supersedes the previous waiter without getting cancelled by the older abort", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  const agentId = "agent-1";
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const message: AgentMessage = {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "hello",
    timestamp: new Date(0).toISOString(),
  };

  const first = orchestrator.receiveMessages(agentId, true, 10_000, firstAbort.signal);
  const second = orchestrator.receiveMessages(agentId, true, 10_000, secondAbort.signal);

  assert.deepEqual(await first, []);

  firstAbort.abort();
  orchestrator.deliverToLocalInbox(agentId, message);

  assert.deepEqual(await second, [message]);
  orchestrator.shutdown();
});

test("buggy concurrent receive semantics let an older abort clear the newer waiter and strand the message", async () => {
  const orchestrator = new BuggyConcurrentReceiveOrchestrator();
  const agentId = "agent-1";
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const message: AgentMessage = {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "hello",
    timestamp: new Date(0).toISOString(),
  };

  const first = orchestrator.receiveMessages(agentId, true, 10_000, firstAbort.signal);
  orchestrator.receiveMessages(agentId, true, 10_000, secondAbort.signal);

  firstAbort.abort();
  assert.deepEqual(await first, []);

  orchestrator.deliverToLocalInbox(agentId, message);

  const inboxes = (orchestrator as any).agentInboxes as Map<string, { inbox: AgentMessage[]; pendingReceive: unknown }>;
  const inbox = inboxes.get(agentId);
  assert.ok(inbox);
  assert.equal(inbox.pendingReceive, null);
  assert.deepEqual(inbox.inbox, [message]);
  orchestrator.shutdown();
});

test("receiveMessages with a pre-aborted signal returns empty without leaving a waiter installed", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  const agentId = "agent-1";
  const abort = new AbortController();
  abort.abort();

  assert.deepEqual(
    await orchestrator.receiveMessages(agentId, true, 10_000, abort.signal),
    [],
  );

  const inboxes = (orchestrator as any).agentInboxes as Map<string, { inbox: AgentMessage[]; pendingReceive: unknown }>;
  const inbox = inboxes.get(agentId);
  assert.ok(inbox);
  assert.equal(inbox.pendingReceive, null);
  orchestrator.shutdown();
});

test("deliverToLocalInbox deduplicates both sequenced and seq-less messages", () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  const agentId = "agent-1";

  orchestrator.deliverToLocalInbox(agentId, {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "seq-1",
    timestamp: new Date(0).toISOString(),
    seq: 1,
    message_id: "m1",
  });
  orchestrator.deliverToLocalInbox(agentId, {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "seq-1 duplicate",
    timestamp: new Date(0).toISOString(),
    seq: 1,
    message_id: "m1-dupe",
  });
  orchestrator.deliverToLocalInbox(agentId, {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "no-seq",
    timestamp: new Date(0).toISOString(),
    message_id: "m-no-seq",
  });
  orchestrator.deliverToLocalInbox(agentId, {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "no-seq duplicate",
    timestamp: new Date(0).toISOString(),
    message_id: "m-no-seq",
  });

  const inbox = (orchestrator as any).agentInboxes.get(agentId);
  assert.ok(inbox);
  assert.equal(inbox.inbox.length, 2);
  assert.deepEqual(
    inbox.inbox.map((msg: AgentMessage) => ({ seq: msg.seq ?? null, message_id: msg.message_id ?? null })),
    [
      { seq: 1, message_id: "m1" },
      { seq: null, message_id: "m-no-seq" },
    ],
  );
  orchestrator.shutdown();
});

test("same-seq membership delivery replaces queued non-member reply limits", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  const agentId = "agent-1";
  const notifyOnlyMessage: AgentMessage = {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "@agent-1 please review",
    timestamp: new Date(0).toISOString(),
    seq: 42,
    message_id: "message-42",
    mentioned: true,
    non_member_mention: true,
  };
  const membershipMessage: AgentMessage = {
    ...notifyOnlyMessage,
  };
  delete membershipMessage.non_member_mention;

  orchestrator.deliverToLocalInbox(agentId, notifyOnlyMessage);
  orchestrator.deliverToLocalInbox(agentId, membershipMessage);
  assert.equal(
    (await orchestrator.receiveMessages(agentId, false, 0))[0]?.non_member_mention,
    true,
    "ordinary same-seq replay must retain the original queued projection",
  );
  orchestrator.deliverToLocalInbox(agentId, membershipMessage, {
    reconcileNonMemberMention: true,
  });

  const received = await orchestrator.receiveMessages(agentId, false, 0);
  assert.equal(received.length, 1, "same persisted seq remains one delivery");
  assert.equal(
    received[0]?.non_member_mention,
    undefined,
    "membership capability must replace the stale notify-only reply limit",
  );
  orchestrator.shutdown();
});

test("deliverToLocalInbox trims to the newest 1000 messages", () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  const agentId = "agent-1";

  for (let seq = 1; seq <= 1001; seq += 1) {
    orchestrator.deliverToLocalInbox(agentId, {
      channel_id: "channel-1",
      channel_name: "general",
      channel_type: "channel",
      sender_id: "user-1",
      sender_name: "tygg",
      sender_type: "human",
      content: `msg-${seq}`,
      timestamp: new Date(0).toISOString(),
      seq,
      message_id: `m${seq}`,
    });
  }

  const inbox = (orchestrator as any).agentInboxes.get(agentId);
  assert.ok(inbox);
  assert.equal(inbox.pendingReceive, null);
  assert.equal(inbox.inbox.length, 1000);
  assert.equal(inbox.inbox[0]?.seq, 2);
  assert.equal(inbox.inbox.at(-1)?.seq, 1001);
  orchestrator.shutdown();
});

test("deliverToLocalInbox resolves a pending waiter with the current snapshot and clears it", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  const agentId = "agent-1";

  const waiter = orchestrator.receiveMessages(agentId, true, 10_000);
  await Promise.resolve();

  orchestrator.deliverToLocalInbox(agentId, {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "msg-1",
    timestamp: new Date(0).toISOString(),
    seq: 1,
    message_id: "m1",
  });

  const delivered = await waiter;
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.seq, 1);

  const inbox = (orchestrator as any).agentInboxes.get(agentId);
  assert.ok(inbox);
  assert.equal(inbox.pendingReceive, null);
  assert.equal(inbox.inbox.length, 1);
  assert.equal(inbox.inbox[0]?.seq, 1);
  orchestrator.shutdown();
});

test("receive delivery remains replayable when the first response-path handoff is lost before daemon consumption", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  const agentId = "agent-1";
  const message: AgentMessage = {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "replay this if the response body never reaches the daemon",
    timestamp: new Date(0).toISOString(),
  };

  const firstAttempt = orchestrator.receiveMessages(agentId, true, 10_000);
  orchestrator.deliverToLocalInbox(agentId, message);

  // The server has already "handed off" the message into the open response.
  // Simulate a weak-network / black-holed response-body failure by discarding
  // that first attempt before daemon-side parse / consumption can happen.
  await firstAttempt;

  const replay = await orchestrator.receiveMessages(agentId, false, 0);

  assert.deepEqual(replay, [message]);
  orchestrator.shutdown();
});

test("receive ack clears replayable inbox state and advances the handoff boundary", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  const agentId = "agent-1";
  const message: AgentMessage = {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "ack this after successful daemon-side consumption",
    timestamp: new Date(0).toISOString(),
    seq: 42,
    message_id: "msg-42",
  };

  orchestrator.deliverToLocalInbox(agentId, message);
  assert.deepEqual(await orchestrator.receiveMessages(agentId, false, 0), [message]);

  orchestrator.acknowledgeDeliveredMessages(agentId, [42]);

  assert.deepEqual(await orchestrator.receiveMessages(agentId, false, 0), []);
  orchestrator.shutdown();
});

test("direct websocket delivery uses the persisted message seq so daemon ack clears replayable inbox state", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator);
  const ws = makeFakeWs(1);
  seedMachineConnection(orchestrator, "machine-1", ws);
  const message = makeAgentMessage("direct websocket delivery should not replay after ack", 42);

  await orchestrator.deliverMessage("agent-1", message);

  const delivered = JSON.parse(ws.sent[0] ?? "{}") as Extract<ServerToMachineMessage, { type: "agent:deliver" }>;
  assert.equal(delivered.type, "agent:deliver");
  assert.equal(delivered.seq, 42);
  assert.deepEqual(await orchestrator.receiveMessages("agent-1", false, 0), [message]);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:deliver:ack",
    agentId: "agent-1",
    seq: delivered.seq,
  });

  assert.deepEqual(await orchestrator.receiveMessages("agent-1", false, 0), []);
  const turnActive = (orchestrator as any).agentActivity.get("agent-1");
  assert.equal(turnActive?.activity, "working");
  assert.equal(turnActive?.detail, "Message received");
  assert.equal(turnActive?.detailKind, "message_received");
  orchestrator.shutdown();
});

test("delivery ack clears inbox but does not reauthor stale runtime activity", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(120_000);
  const persistedLogs = new Map<string, Array<{ timestamp: number; entry: TrajectoryEntry }>>();
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(persistedLogs, clock, tracer);
  seedActiveAgent(orchestrator);
  (orchestrator as any).agentStateCache.get("agent-1").runtimeState = "working";
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs(1));
  orchestrator.deliverToLocalInbox("agent-1", makeAgentMessage("stale busy must not be refreshed by ack", 42));
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "Long tool call",
    detailKind: "running_command",
    observedAtMs: clock.now() - 91_000,
    updatedAt: clock.now(),
  });

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:deliver:ack",
    agentId: "agent-1",
    seq: 42,
  } as MachineToServerMessage);

  assert.deepEqual(await orchestrator.receiveMessages("agent-1", false, 0), []);
  const snapshot = (orchestrator as any).agentActivity.get("agent-1");
  assert.equal(snapshot?.activity, "working");
  assert.equal(snapshot?.detail, "Long tool call");
  assert.equal(snapshot?.detailKind, "running_command");
  assert.equal(snapshot?.observedAtMs, clock.now() - 91_000);
  assert.equal(snapshot?.updatedAt, clock.now());

  const events = sink.getAllSpans().flatMap((span) => span.events);
  const skipped = events.find((event) => event.name === "turn_active.skipped");
  assert.equal(skipped?.attrs?.reason, "stale_runtime_observation");
  assert.equal(
    events.some((event) => event.name === "turn_active.observed"),
    false,
    "stale runtime observation must not be refreshed by delivery ack",
  );
  assert.deepEqual(
    await orchestrator.listRecentActivityLog("agent-1"),
    [],
    "rejected delivery ack must not leak user-visible Message received into Activity",
  );
  orchestrator.shutdown();
});

test("delivery ack clears inbox but does not author turn-active when runtime liveness failed", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);
  seedActiveAgent(orchestrator);
  (orchestrator as any).agentStateCache.get("agent-1").runtimeState = "not_running";
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs(1));
  orchestrator.deliverToLocalInbox("agent-1", makeAgentMessage("ack while runtime is not running", 42));
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "online",
    detail: "Idle",
    detailKind: "idle",
    updatedAt: Date.now(),
  });

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:deliver:ack",
    agentId: "agent-1",
    seq: 42,
  } as MachineToServerMessage);

  assert.deepEqual(await orchestrator.receiveMessages("agent-1", false, 0), []);
  const snapshot = (orchestrator as any).agentActivity.get("agent-1");
  assert.equal(snapshot?.activity, "online");
  assert.equal(snapshot?.detailKind, "idle");
  const skipped = sink.getAllSpans()
    .flatMap((span) => span.events)
    .find((event) => event.name === "turn_active.skipped");
  assert.equal(skipped?.attrs?.reason, "runtime_liveness_failed_or_unknown");
  orchestrator.shutdown();
});

test("delivery ack rejects cross-machine authority before clearing inbox or writing turn-active", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-2", makeFakeWs(1));
  const message = makeAgentMessage("wrong machine ack must not clear or author activity", 42);

  orchestrator.deliverToLocalInbox("agent-1", message);
  await orchestrator.handleMachineMessage("machine-2", {
    type: "agent:deliver:ack",
    agentId: "agent-1",
    seq: 42,
  } as MachineToServerMessage);

  assert.deepEqual(await orchestrator.receiveMessages("agent-1", false, 0), [message]);
  assert.equal((orchestrator as any).agentActivity.get("agent-1"), undefined);
  orchestrator.shutdown();
});

test("delivery ack turn-active overlay resolves Starting before first daemon runtime event", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(60_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock, tracer);
  seedActiveAgent(orchestrator);
  (orchestrator as any).agentStateCache.get("agent-1").runtimeState = "starting";
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs(1));
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "Starting…",
    detailKind: "starting",
    updatedAt: clock.now() - 1_000,
  });
  orchestrator.deliverToLocalInbox("agent-1", makeAgentMessage("turn active", 42));

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:deliver:ack",
    agentId: "agent-1",
    seq: 42,
  } as MachineToServerMessage);
  const resolveSpan = tracer.startSpan("test.resolve_starting_after_ack", { surface: "server", kind: "internal" });
  (orchestrator as any).maybeResolveStartingActivity("agent-1", resolveSpan);
  resolveSpan.end("ok");

  const snapshot = (orchestrator as any).agentActivity.get("agent-1");
  assert.equal(snapshot?.activity, "working", "ack-proven turn_active must not fall back to Idle/online");
  assert.equal(snapshot?.detailKind, "message_received");
  assert.deepEqual(
    await orchestrator.listRecentActivityLog("agent-1"),
    [],
    "delivery ack is a live liveness overlay; daemon trajectory owns durable Activity history",
  );
  assert.equal(orchestrator.emittedActivityPayloads.length, 1);
  assert.equal(orchestrator.emittedActivityPayloads[0]?.isRefreshOnly, true);
  assert.equal(orchestrator.emittedActivityPayloads[0]?.entries, undefined);

  const verdicts = sink.getAllSpans()
    .flatMap((span) => span.events)
    .filter((event) => event.name === "lifecycle_v2.shadow_verdict")
    .map((event) => event.attrs ?? {});
  const ackVerdict = verdicts.find((verdict) => verdict.shadow_signal_site === "delivery_ack");
  assert.ok(ackVerdict, "delivery ack write must carry writer provenance");
  assert.equal(ackVerdict.shadow_observation_class, "observed_turn_active");
  assert.equal(ackVerdict.authority, "observed_turn_active");
  assert.equal(ackVerdict.event_kind, "turn_active");

  const resolveEvent = sink.getAllSpans()
    .flatMap((span) => span.events)
    .find((event) => event.name === "starting_activity.resolve");
  assert.equal(resolveEvent?.attrs?.outcome, "skip");
  assert.equal(resolveEvent?.attrs?.reason, "not_starting_detail");
  orchestrator.shutdown();
});

test("ack, daemon entry, probe, heartbeat, and stale repair preserve one durable Activity fact", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(60_000);
  const orchestrator = new SyntheticRepairFactDeterministicOrchestrator(new Map(), clock, tracer);
  seedActiveAgent(orchestrator);
  (orchestrator as any).agentStateCache.get("agent-1").runtimeState = "starting";
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs(1));
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "Starting…",
    detailKind: "starting",
    updatedAt: clock.now() - 1_000,
  });
  orchestrator.deliverToLocalInbox("agent-1", makeAgentMessage("one durable fact", 42));

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:deliver:ack",
    agentId: "agent-1",
    seq: 42,
  } as MachineToServerMessage);
  clock.advance(2);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "Message received",
    detailKind: "message_received",
    launchId: "L-1",
    clientSeq: 1,
    producerFactId: "daemon_activity:agent-1:L-1:1",
    isHeartbeat: false,
    entries: [{
      kind: "status",
      activity: "working",
      activityKind: "working",
      detail: "Message received",
      detailKind: "message_received",
    }],
  } as MachineToServerMessage);
  await flushMicrotasks();

  clock.advance(20_000);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "Message received",
    detailKind: "message_received",
    launchId: "L-1",
    clientSeq: 2,
    producerFactId: "daemon_activity:agent-1:L-1:2",
    probeId: "probe-1",
    isHeartbeat: false,
  } as MachineToServerMessage);
  await flushMicrotasks();

  clock.advance(40_000);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "Message received",
    detailKind: "message_received",
    launchId: "L-1",
    clientSeq: 3,
    producerFactId: "daemon_activity:agent-1:L-1:3",
    isHeartbeat: true,
  } as MachineToServerMessage);
  await flushMicrotasks();

  const snapshotBeforeRepair = structuredClone((orchestrator as any).agentActivity.get("agent-1"));
  const emittedBeforeRepair = structuredClone(orchestrator.emittedActivityPayloads);
  const durableBeforeRepair = await orchestrator.listRecentActivityLog("agent-1");

  clock.advance(91_000);
  orchestrator.callApplyStaleActivitySweepAction("sweep-online", "agent-1", clock.now());
  await flushMicrotasks(10);

  const expectedDurable = [{
    timestamp: 60_002,
    entry: {
      kind: "status",
      activity: "working",
      activityKind: "working",
      detail: "Message received",
      detailKind: "message_received",
    },
  }] satisfies Array<{ timestamp: number; entry: TrajectoryEntry }>;
  assert.deepEqual(durableBeforeRepair, expectedDurable);
  assert.deepEqual(
    await orchestrator.listRecentActivityLog("agent-1"),
    expectedDurable,
    "stale repair must persist zero facts",
  );
  assert.equal(orchestrator.emittedActivityPayloads.length, 4);
  assert.equal(orchestrator.emittedActivityPayloads[0]?.isRefreshOnly, true);
  assert.equal(orchestrator.emittedActivityPayloads[0]?.entries, undefined);
  assert.equal(orchestrator.emittedActivityPayloads[1]?.isRefreshOnly, undefined);
  assert.equal(orchestrator.emittedActivityPayloads[1]?.activity, "working");
  assert.equal(orchestrator.emittedActivityPayloads[1]?.detail, "Message received");
  assert.equal(orchestrator.emittedActivityPayloads[2]?.probeId, "probe-1");
  assert.equal(orchestrator.emittedActivityPayloads[2]?.isRefreshOnly, true);
  assert.equal(orchestrator.emittedActivityPayloads[2]?.isHeartbeat, undefined);
  assert.equal(orchestrator.emittedActivityPayloads[3]?.isHeartbeat, true);
  assert.equal(orchestrator.emittedActivityPayloads[3]?.isRefreshOnly, true);
  assert.deepEqual(
    orchestrator.emittedActivityPayloads,
    emittedBeforeRepair,
    "stale repair must emit zero socket frames",
  );
  assert.deepEqual(
    (orchestrator as any).agentActivity.get("agent-1"),
    snapshotBeforeRepair,
    "stale repair must not rewrite the activity map or observed clock",
  );
  assert.equal((orchestrator as any).activityDebounceTimers.has("agent-1"), false);

  const [repairSpan] = sink.getTrace(traceId).filter((span) => span.name === "server.agent.synthetic_repair.apply");
  assert.ok(repairSpan, "stale repair must remain trace-visible");
  assert.equal(repairSpan.attrs?.authority, "scheduler_repair");
  assert.equal(repairSpan.attrs?.reason, "synthetic_no_authority");
  assert.equal(repairSpan.attrs?.previous_activity, "working");
  assert.equal(repairSpan.attrs?.candidate_activity, "online");
  assert.equal(repairSpan.attrs?.served_activity, "working");
  assert.equal(repairSpan.attrs?.projection_outcome, "preserved_without_write");
  assert.equal(repairSpan.attrs?.advances_observed_clock, "none");
  const repairEventNames = repairSpan.events.map((event) => event.name);
  assert.ok(repairEventNames.includes("lifecycle_v2.shadow_verdict"));
  assert.equal(repairEventNames.includes("agent.lifecycle.event"), false);
  assert.equal(repairEventNames.includes("agent.lifecycle.projection"), false);

  orchestrator.shutdown();
});

test("noop delivery ack does not resurrect turn-active overlay", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs(1));
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "online",
    detail: "Idle",
    detailKind: "idle",
    updatedAt: Date.now(),
  });

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:deliver:ack",
    agentId: "agent-1",
    seq: 42,
  } as MachineToServerMessage);

  const snapshot = (orchestrator as any).agentActivity.get("agent-1");
  assert.equal(snapshot?.activity, "online");
  assert.equal(snapshot?.detailKind, "idle");
  orchestrator.shutdown();
});

test("direct transient delivery skips replayable server inbox and marks the machine frame transient", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator);
  const ws = makeFakeWs(1);
  seedMachineConnection(orchestrator, "machine-1", ws);
  const message = makeAgentMessage("transient reminder fire", 0);
  delete message.seq;
  delete message.message_id;

  await orchestrator.deliverMessage("agent-1", message, { transient: true, intrinsic: true });

  const delivered = JSON.parse(ws.sent[0] ?? "{}") as Extract<ServerToMachineMessage, { type: "agent:deliver" }>;
  assert.equal(delivered.type, "agent:deliver");
  assert.equal(delivered.transient, true);
  assert.deepEqual(await orchestrator.receiveMessages("agent-1", false, 0), []);
  orchestrator.shutdown();
});

test("attempt-wake transient delivery marks agent:start wakeMessage transient", async () => {
  const orchestrator = new LaunchGuardDeterministicAgentOrchestrator(new InMemoryReplicaStateStore());
  seedActiveAgent(orchestrator);
  (orchestrator as any).agentStateCache.get("agent-1").runtimeState = "not_running";
  const message = makeAgentMessage("transient reminder fire", 0);
  delete message.seq;
  delete message.message_id;

  await orchestrator.deliverMessage("agent-1", message, { transient: true, intrinsic: true });

  assert.equal(orchestrator.startMessages.length, 1);
  assert.equal(orchestrator.startMessages[0]?.wakeMessageTransient, true);
  assert.deepEqual(orchestrator.startMessages[0]?.wakeMessage, message);
  assert.deepEqual(await orchestrator.receiveMessages("agent-1", false, 0), []);
  orchestrator.shutdown();
});

test("direct websocket delivery tolerates immediate daemon ack before deliverMessage returns", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator);
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    sent,
    send(data: string) {
      sent.push(data);
      const delivered = JSON.parse(data) as Extract<ServerToMachineMessage, { type: "agent:deliver" }>;
      void orchestrator.handleMachineMessage("machine-1", {
        type: "agent:deliver:ack",
        agentId: delivered.agentId,
        seq: delivered.seq,
      });
    },
    terminate() {
      this.readyState = 3;
    },
    close() {
      this.readyState = 3;
    },
  };
  seedMachineConnection(orchestrator, "machine-1", ws);
  const message = makeAgentMessage("immediate ack should clear replayable inbox", 43);

  await orchestrator.deliverMessage("agent-1", message);
  await flushMicrotasks();

  const delivered = JSON.parse(sent[0] ?? "{}") as Extract<ServerToMachineMessage, { type: "agent:deliver" }>;
  assert.equal(delivered.seq, 43);
  assert.deepEqual(await orchestrator.receiveMessages("agent-1", false, 0), []);
  orchestrator.shutdown();
});

test("direct delivery trace stitches immediate server send, daemon receive, and server ack clear", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);
  seedActiveAgent(orchestrator);
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    sent,
    send(data: string) {
      sent.push(data);
      const delivered = JSON.parse(data) as Extract<ServerToMachineMessage, { type: "agent:deliver" }>;
      const daemonSpan = tracer.startSpan("daemon.agent.delivery", {
        parent: parseTraceparent(delivered.traceparent),
        surface: "daemon",
        kind: "consumer",
        attrs: {
          agentId: delivered.agentId,
          deliveryId: delivered.deliveryId,
          delivery_correlation_id: delivered.deliveryId,
          seq: delivered.seq,
        },
      });
      daemonSpan.addEvent("daemon.receive", { seq: delivered.seq });
      daemonSpan.addEvent("daemon.deliver_to_agent_manager");
      daemonSpan.addEvent("daemon.ack.sent", { seq: delivered.seq });
      void orchestrator.handleMachineMessage("machine-1", {
        type: "agent:deliver:ack",
        agentId: delivered.agentId,
        seq: delivered.seq,
        traceparent: formatTraceparent(daemonSpan.context),
        deliveryId: delivered.deliveryId,
      });
      daemonSpan.end("ok", { attrs: { outcome: "ack-sent" } });
    },
    terminate() {
      this.readyState = 3;
    },
    close() {
      this.readyState = 3;
    },
  };
  seedMachineConnection(orchestrator, "machine-1", ws);
  const message = makeAgentMessage("trace full direct delivery ack chain", 44);
  const requestSpan = tracer.startSpan("server.http.request", {
    surface: "server",
    kind: "server",
  });

  await runWithTraceSpan(requestSpan, () => orchestrator.deliverMessage("agent-1", message), tracer);
  requestSpan.end("ok");
  await flushMicrotasks();

  const delivered = JSON.parse(sent[0] ?? "{}") as Extract<ServerToMachineMessage, { type: "agent:deliver" }>;
  assert.ok(delivered.traceparent);
  assert.match(delivered.deliveryId ?? "", /^[0-9a-f-]{36}$/i);
  assert.deepEqual(await orchestrator.receiveMessages("agent-1", false, 0), []);

  const trace = sink.getTrace(traceId);
  const serverDelivery = trace.find((span) => span.name === "server.agent.delivery");
  const daemonDelivery = trace.find((span) => span.name === "daemon.agent.delivery");
  const serverAck = trace.find((span) => span.name === "server.agent.delivery.ack");
  assert.ok(serverDelivery, "missing server delivery span");
  assert.ok(daemonDelivery, "missing daemon delivery span");
  assert.ok(serverAck, "missing server ack span");
  assert.equal(serverDelivery.context.parentSpanId, requestSpan.context.spanId);
  assert.equal(daemonDelivery.context.parentSpanId, serverDelivery.context.spanId);
  assert.equal(serverAck.context.parentSpanId, daemonDelivery.context.spanId);
  assert.equal(serverDelivery.attrs?.agent_id_present, true);
  assert.equal(serverDelivery.attrs?.machine_id_present, true);
  assert.equal(serverDelivery.attrs?.deliveryId, delivered.deliveryId);
  assert.equal(daemonDelivery.attrs?.deliveryId, delivered.deliveryId);
  assert.equal(serverAck.attrs?.deliveryId, delivered.deliveryId);
  assert.equal(serverAck.attrs?.agent_id_present, true);
  assert.equal(serverAck.attrs?.machine_id_present, true);
  assert.equal(serverDelivery.attrs?.agent_id, "agent-1");
  assert.equal(serverDelivery.attrs?.machine_id, "machine-1");
  assert.equal(serverDelivery.attrs?.server_id, "server-1");
  assert.equal(serverAck.attrs?.agent_id, "agent-1");
  assert.equal(serverAck.attrs?.machine_id, "machine-1");
  assert.equal(serverAck.attrs?.server_id, "server-1");
  const serverDeliveryEvents = eventsForSpan(sink, traceId, "server.agent.delivery").map((event) => event.name);
  assert.deepEqual(serverDeliveryEvents, [
    "server.deliver.enqueued",
    "inbox.ready",
    "server.ws.send.attempted",
  ]);
  assert.ok(
    serverDeliveryEvents.indexOf("inbox.ready") < serverDeliveryEvents.indexOf("server.ws.send.attempted"),
    "trace should prove replayable inbox state exists before immediate websocket ack can fire",
  );
  assert.deepEqual(eventsForSpan(sink, traceId, "daemon.agent.delivery").map((event) => event.name), [
    "daemon.receive",
    "daemon.deliver_to_agent_manager",
    "daemon.ack.sent",
  ]);
  assert.deepEqual(eventsForSpan(sink, traceId, "server.agent.delivery.ack").map((event) => event.name), [
    "server.ack.received",
    "inbox.cleared",
    "lifecycle_v2.shadow_verdict",
    "turn_active.observed",
  ]);
  const deliveryRows = traceEventRowsForSpanName(sink, traceId, "server.agent.delivery");
  const inboxReadyRow = deliveryRows.find((row) => row.event_name === "inbox.ready");
  assert.ok(inboxReadyRow);
  assert.equal(inboxReadyRow.agent_id, "agent-1");
  assert.equal(inboxReadyRow.machine_id, "machine-1");
  assert.equal(inboxReadyRow.server_id, "server-1");
  assert.equal(inboxReadyRow.outcome, "prepared");
  assert.equal(inboxReadyRow.reason, "local_fallback_inbox");
  const wsSendRow = deliveryRows.find((row) => row.event_name === "server.ws.send.attempted");
  assert.ok(wsSendRow);
  assert.equal(wsSendRow.agent_id, "agent-1");
  assert.equal(wsSendRow.machine_id, "machine-1");
  assert.equal(wsSendRow.server_id, "server-1");
  assert.equal(wsSendRow.outcome, "attempted");
  assert.equal(wsSendRow.reason, "machine_present");
  const deliveryFact = traceSpanFactRowForSpanName(sink, traceId, "server.agent.delivery");
  assert.equal(deliveryFact.row_kind, "span_fact");
  assert.equal(deliveryFact.agent_id, "agent-1");
  assert.equal(deliveryFact.machine_id, "machine-1");
  assert.equal(deliveryFact.server_id, "server-1");
  assert.equal(deliveryFact.outcome, "ws-send-attempted");
  assert.equal(deliveryFact.reason, "machine_present");
  const ackRows = traceEventRowsForSpanName(sink, traceId, "server.agent.delivery.ack");
  const ackReceivedRow = ackRows.find((row) => row.event_name === "server.ack.received");
  assert.ok(ackReceivedRow);
  assert.equal(ackReceivedRow.agent_id, "agent-1");
  assert.equal(ackReceivedRow.machine_id, "machine-1");
  assert.equal(ackReceivedRow.server_id, "server-1");
  assert.equal(ackReceivedRow.outcome, "received");
  assert.equal(ackReceivedRow.reason, "daemon_delivery_ack");
  const ackClearedRow = ackRows.find((row) => row.event_name === "inbox.cleared");
  assert.ok(ackClearedRow);
  assert.equal(ackClearedRow.agent_id, "agent-1");
  assert.equal(ackClearedRow.machine_id, "machine-1");
  assert.equal(ackClearedRow.server_id, "server-1");
  assert.equal(ackClearedRow.outcome, "cleared");
  assert.equal(ackClearedRow.reason, "acknowledged_seq");
  const turnActiveRow = ackRows.find((row) => row.event_name === "turn_active.observed");
  assert.ok(turnActiveRow);
  assert.equal(turnActiveRow.agent_id, "agent-1");
  assert.equal(turnActiveRow.machine_id, "machine-1");
  assert.equal(turnActiveRow.server_id, "server-1");
  assert.equal(turnActiveRow.outcome, "applied");
  assert.equal(turnActiveRow.reason, "daemon_delivery_ack");
  const ackFact = traceSpanFactRowForSpanName(sink, traceId, "server.agent.delivery.ack");
  assert.equal(ackFact.row_kind, "span_fact");
  assert.equal(ackFact.agent_id, "agent-1");
  assert.equal(ackFact.machine_id, "machine-1");
  assert.equal(ackFact.server_id, "server-1");
  assert.equal(ackFact.outcome, "cleared-inbox");
  assert.equal(ackFact.reason, "acknowledged_seq");
  orchestrator.shutdown();
});

test("direct delivery trace shows daemon receive without ack when ack is lost", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), undefined, tracer);
  seedActiveAgent(orchestrator);
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    sent,
    send(data: string) {
      sent.push(data);
      const delivered = JSON.parse(data) as Extract<ServerToMachineMessage, { type: "agent:deliver" }>;
      const daemonSpan = tracer.startSpan("daemon.agent.delivery", {
        parent: parseTraceparent(delivered.traceparent),
        surface: "daemon",
        kind: "consumer",
        attrs: {
          agentId: delivered.agentId,
          deliveryId: delivered.deliveryId,
          delivery_correlation_id: delivered.deliveryId,
          seq: delivered.seq,
        },
      });
      daemonSpan.addEvent("daemon.receive", { seq: delivered.seq });
      daemonSpan.addEvent("daemon.deliver_to_agent_manager");
      daemonSpan.end("ok", { attrs: { outcome: "no-ack" } });
    },
    terminate() {
      this.readyState = 3;
    },
    close() {
      this.readyState = 3;
    },
  };
  seedMachineConnection(orchestrator, "machine-1", ws);
  const message = makeAgentMessage("trace should identify lost ack boundary", 45);

  await orchestrator.deliverMessage("agent-1", message);
  await flushMicrotasks();

  assert.deepEqual(await orchestrator.receiveMessages("agent-1", false, 0), [message]);
  assert.deepEqual(eventsForSpan(sink, traceId, "daemon.agent.delivery").map((event) => event.name), [
    "daemon.receive",
    "daemon.deliver_to_agent_manager",
  ]);
  const serverDelivery = sink.getTrace(traceId).find((span) => span.name === "server.agent.delivery");
  assert.ok(serverDelivery);
  assert.equal(serverDelivery.context.parentSpanId, null, "background delivery without request context remains a legal root");
  assert.equal(sink.getTrace(traceId).some((span) => span.name === "server.agent.delivery.ack"), false);
  orchestrator.shutdown();
});

test("direct websocket delivery retries the original packet until daemon ack arrives", async () => {
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), clock);
  seedActiveAgent(orchestrator);
  const ws = makeFakeWs(1);
  seedMachineConnection(orchestrator, "machine-1", ws);
  const message = makeAgentMessage("retry exact delivery packet after ack timeout", 46);

  await orchestrator.deliverMessage("agent-1", message);
  await flushMicrotasks();

  assert.equal(ws.sent.length, 1);
  const first = JSON.parse(ws.sent[0] ?? "{}") as Extract<ServerToMachineMessage, { type: "agent:deliver" }>;
  assert.equal(first.type, "agent:deliver");

  clock.advance(5_000);
  await flushMicrotasks(10);

  assert.equal(ws.sent.length, 2);
  const retry = JSON.parse(ws.sent[1] ?? "{}") as Extract<ServerToMachineMessage, { type: "agent:deliver" }>;
  assert.equal(retry.type, "agent:deliver");
  assert.equal(retry.deliveryId, first.deliveryId);
  assert.equal(retry.seq, first.seq);
  assert.deepEqual(retry.message, first.message);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:deliver:ack",
    agentId: "agent-1",
    seq: retry.seq,
    deliveryId: retry.deliveryId,
  });

  clock.advance(5_000);
  await flushMicrotasks(10);

  assert.equal(ws.sent.length, 2);
  assert.deepEqual(await orchestrator.receiveMessages("agent-1", false, 0), []);
  orchestrator.shutdown();
});

test("machine reconnect replays an unacknowledged queued start without a second user action", async () => {
  const clock = new FakeClock();
  const orchestrator = new StartRoutingMismatchDeterministicOrchestrator(
    new InMemoryReplicaStateStore(),
    clock,
  );
  const staleWs = makeFakeWs(1);
  seedMachineConnection(orchestrator, "machine-1", staleWs);

  await orchestrator.startAgent("agent-1");
  await flushMicrotasks();

  assert.equal(staleWs.sent.length, 1);
  const first = JSON.parse(staleWs.sent[0] ?? "{}") as Extract<
    ServerToMachineMessage,
    { type: "agent:start" }
  > & { startDispatchId?: string };
  assert.equal(first.type, "agent:start");
  assert.ok(first.startDispatchId, "start must carry a stable dispatch identity");

  await orchestrator.unregisterMachine("machine-1");
  clock.advance(5_000);
  await flushMicrotasks(10);

  const parked = (orchestrator as any).pendingAgentStartAcks.get(first.startDispatchId);
  assert.ok(parked, "offline dispatch must remain queryable");
  assert.equal(parked.parked, true);
  assert.equal(parked.attempts, 1, "offline parking must not count as a send attempt");
  assert.equal(
    parked.nextRetryAt,
    10_000,
    "offline ownership probe must remain queryable without consuming an attempt",
  );

  clock.advance(10_000);
  await flushMicrotasks(10);
  const aged = (orchestrator as any).startDispatchTraceAttrs(parked);
  assert.equal(aged.queue_age_ms, 15_000, "queue age must continue while offline");
  assert.equal(aged.attempts, 1, "offline time must not consume retry attempts");

  const freshWs = makeFakeWs(1);
  await orchestrator.registerMachine("machine-1", "server-1", freshWs as never);
  await flushMicrotasks(10);

  assert.equal(freshWs.sent.length, 1, "registration must replay before waiting for daemon ready");
  const replay = JSON.parse(freshWs.sent[0] ?? "{}") as typeof first;
  assert.equal(replay.type, "agent:start");
  assert.equal(replay.startDispatchId, first.startDispatchId);
  assert.equal(replay.launchId, first.launchId);
  assert.equal(parked.attempts, 2, "register replay must count exactly one real send");
  assert.equal((orchestrator as any).startDispatchTraceAttrs(parked).queue_age_ms, 15_000);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:start:ack",
    agentId: "agent-1",
    launchId: replay.launchId,
    startDispatchId: replay.startDispatchId,
    queueState: "queued",
    queueDepth: 1,
    queueAgeMs: 0,
  } as MachineToServerMessage);

  clock.advance(5_000);
  await flushMicrotasks(10);
  assert.equal(freshWs.sent.length, 1, "daemon queue receipt must terminate replay");
  assert.equal((orchestrator as any).pendingAgentStartAcks.has(first.startDispatchId), false);
  assert.equal(
    (orchestrator as any).terminalAgentStartDispatches.get(first.startDispatchId),
    "acked",
  );
  orchestrator.shutdown();
});

test("initial queued-start send projects its live attempt and retry schedule before timeout", async () => {
  const clock = new FakeClock();
  clock.advance(1_000);
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new StartRoutingMismatchDeterministicOrchestrator(
    new InMemoryReplicaStateStore(),
    clock,
    tracer,
  );
  const ws = makeFakeWs(1);
  seedMachineConnection(orchestrator, "machine-1", ws);

  await orchestrator.startAgent("agent-1");
  await flushMicrotasks();

  const attempt = sink.getTrace(traceId)
    .find((span) => span.name === "server.agent.start_dispatch.attempted");
  assert.ok(attempt, "the first real send must emit a queryable attempt transition");
  assert.equal(attempt.attrs?.outcome, "sent");
  assert.equal(attempt.attrs?.attempts, 1);
  assert.equal(attempt.attrs?.last_attempt_at_ms, 1_000);
  assert.equal(attempt.attrs?.next_retry_at_ms, 6_000);
  orchestrator.shutdown();
});

test("late queued-start receipt after stop is ignored and cannot revive the dispatch", async () => {
  const clock = new FakeClock();
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const orchestrator = new StartRoutingMismatchDeterministicOrchestrator(
    new InMemoryReplicaStateStore(),
    clock,
    tracer,
  );
  const ws = makeFakeWs(1);
  seedMachineConnection(orchestrator, "machine-1", ws);

  await orchestrator.startAgent("agent-1");
  await flushMicrotasks();
  const start = JSON.parse(ws.sent[0] ?? "{}") as Extract<
    ServerToMachineMessage,
    { type: "agent:start" }
  > & { startDispatchId: string };
  assert.ok(start.startDispatchId);

  await orchestrator.stopAgent("agent-1");
  await flushMicrotasks(10);
  assert.equal(
    (orchestrator as any).terminalAgentStartDispatches.get(start.startDispatchId),
    "stopped",
  );

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:start:ack",
    agentId: "agent-1",
    launchId: start.launchId,
    startDispatchId: start.startDispatchId,
    queueState: "running",
    queueDepth: 0,
    queueAgeMs: 0,
  } as MachineToServerMessage);

  const lateAck = sink.getTrace(traceId)
    .find((span) =>
      span.name === "server.agent.start_dispatch.ack"
      && span.attrs?.start_dispatch_id === start.startDispatchId);
  assert.ok(lateAck);
  assert.equal(lateAck.attrs?.outcome, "ignored_terminal");
  assert.equal(lateAck.attrs?.terminal_reason, "stopped");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1")?.status, "stopped");

  const startPacketCount = () => ws.sent.filter((packet) =>
    (JSON.parse(packet) as { type?: string }).type === "agent:start").length;
  assert.equal(startPacketCount(), 1);
  clock.advance(5_000);
  await flushMicrotasks(10);
  assert.equal(startPacketCount(), 1, "terminal dispatch must never schedule another replay");
  orchestrator.shutdown();
});

test("queued-start receipt must match the exact launch identity", async () => {
  const clock = new FakeClock();
  const orchestrator = new StartRoutingMismatchDeterministicOrchestrator(
    new InMemoryReplicaStateStore(),
    clock,
  );
  const ws = makeFakeWs(1);
  seedMachineConnection(orchestrator, "machine-1", ws);

  await orchestrator.startAgent("agent-1");
  await flushMicrotasks();
  const start = JSON.parse(ws.sent[0] ?? "{}") as Extract<
    ServerToMachineMessage,
    { type: "agent:start" }
  > & { startDispatchId: string };
  assert.ok(start.launchId);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:start:ack",
    agentId: start.agentId,
    startDispatchId: start.startDispatchId,
    queueState: "queued",
    queueDepth: 1,
    queueAgeMs: 0,
  } as MachineToServerMessage);
  assert.equal(
    (orchestrator as any).pendingAgentStartAcks.has(start.startDispatchId),
    true,
    "a receipt missing the guarded launch must not terminate replay",
  );

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:start:ack",
    agentId: start.agentId,
    launchId: start.launchId,
    startDispatchId: start.startDispatchId,
    queueState: "queued",
    queueDepth: 1,
    queueAgeMs: 0,
  } as MachineToServerMessage);
  assert.equal(
    (orchestrator as any).pendingAgentStartAcks.has(start.startDispatchId),
    false,
  );
  orchestrator.shutdown();
});

test("machine ready reconcile retries pending direct delivery lost before socket consumption", async () => {
  const clock = new FakeClock();
  const orchestrator = new ReadyReconcileSocketDeliveryOrchestrator(new InMemoryReplicaStateStore(), clock);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  const staleWs = makeFakeWs(3);
  seedMachineConnection(orchestrator, "machine-1", staleWs);
  const message = makeAgentMessage("retry on ready after deploy-window socket gap", 47);

  await orchestrator.deliverMessage("agent-1", message);
  await flushMicrotasks();

  assert.equal(staleWs.sent.length, 0);
  const freshWs = makeFakeWs(1);
  seedMachineConnection(orchestrator, "machine-1", freshWs);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [],
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: ["agent-1"],
  } as MachineToServerMessage);
  await flushMicrotasks(10);

  assert.equal(freshWs.sent.length, 1);
  const retried = JSON.parse(freshWs.sent[0] ?? "{}") as Extract<ServerToMachineMessage, { type: "agent:deliver" }>;
  assert.equal(retried.type, "agent:deliver");
  assert.equal(retried.seq, 47);
  assert.deepEqual(retried.message, message);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:deliver:ack",
    agentId: "agent-1",
    seq: retried.seq,
    deliveryId: retried.deliveryId,
  });
  clock.advance(5_000);
  await flushMicrotasks(10);

  assert.equal(freshWs.sent.length, 1);
  assert.deepEqual(await orchestrator.receiveMessages("agent-1", false, 0), []);
  orchestrator.shutdown();
});

test("ack timeout retries pending delivery when the machine socket appears after the first send", async () => {
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), clock);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  const message = makeAgentMessage("retry when stale registry resolves before ready", 48);

  await orchestrator.deliverMessage("agent-1", message);
  await flushMicrotasks();

  const freshWs = makeFakeWs(1);
  seedMachineConnection(orchestrator, "machine-1", freshWs);
  clock.advance(5_000);
  await flushMicrotasks(10);

  assert.equal(freshWs.sent.length, 1);
  const retried = JSON.parse(freshWs.sent[0] ?? "{}") as Extract<ServerToMachineMessage, { type: "agent:deliver" }>;
  assert.equal(retried.type, "agent:deliver");
  assert.equal(retried.seq, 48);
  assert.deepEqual(retried.message, message);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:deliver:ack",
    agentId: "agent-1",
    seq: retried.seq,
    deliveryId: retried.deliveryId,
  });
  clock.advance(5_000);
  await flushMicrotasks(10);

  assert.equal(freshWs.sent.length, 1);
  assert.deepEqual(await orchestrator.receiveMessages("agent-1", false, 0), []);
  orchestrator.shutdown();
});

test("ack timeout parks pending delivery while machine is offline and ready reconcile flushes it", async () => {
  const clock = new FakeClock();
  const orchestrator = new ReadyReconcileSocketDeliveryOrchestrator(new InMemoryReplicaStateStore(), clock);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  const message = makeAgentMessage("park offline delivery until ready reconcile", 49);

  await orchestrator.deliverMessage("agent-1", message);
  await flushMicrotasks();

  const pendingAcks = (orchestrator as any).pendingAgentDeliveryAcks as Map<string, { attempts: number; parked: boolean; timer: unknown | null }>;
  assert.equal(pendingAcks.size, 1);
  const [pendingBeforeTimeout] = pendingAcks.values();
  assert.equal(pendingBeforeTimeout?.attempts, 1);

  clock.advance(5_000);
  await flushMicrotasks(10);

  const [parkedPending] = pendingAcks.values();
  assert.equal(pendingAcks.size, 1);
  assert.equal(parkedPending?.parked, true);
  assert.equal(parkedPending?.attempts, 1);
  assert.equal(parkedPending?.timer, null);

  clock.advance(60_000);
  await flushMicrotasks(10);

  const [stillParked] = pendingAcks.values();
  assert.equal(pendingAcks.size, 1);
  assert.equal(stillParked?.parked, true);
  assert.equal(stillParked?.attempts, 1);

  const freshWs = makeFakeWs(1);
  seedMachineConnection(orchestrator, "machine-1", freshWs);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [],
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: ["agent-1"],
  } as MachineToServerMessage);
  await flushMicrotasks(10);

  assert.equal(freshWs.sent.length, 1);
  const retried = JSON.parse(freshWs.sent[0] ?? "{}") as Extract<ServerToMachineMessage, { type: "agent:deliver" }>;
  assert.equal(retried.type, "agent:deliver");
  assert.equal(retried.seq, 49);
  assert.deepEqual(retried.message, message);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:deliver:ack",
    agentId: "agent-1",
    seq: retried.seq,
    deliveryId: retried.deliveryId,
  });
  assert.equal(pendingAcks.size, 0);
  orchestrator.shutdown();
});

test("parked pending delivery still drops on stop before ready reconcile", async () => {
  const clock = new FakeClock();
  const orchestrator = new ReadyReconcileSocketDeliveryOrchestrator(new InMemoryReplicaStateStore(), clock);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  const message = makeAgentMessage("parked delivery must not cross stop boundary", 50);

  await orchestrator.deliverMessage("agent-1", message);
  await flushMicrotasks();

  const pendingAcks = (orchestrator as any).pendingAgentDeliveryAcks as Map<string, { attempts: number; parked: boolean }>;
  clock.advance(5_000);
  await flushMicrotasks(10);
  assert.equal(pendingAcks.size, 1);
  assert.equal([...pendingAcks.values()][0]?.parked, true);

  (orchestrator as any).agentStateCache.get("agent-1").status = "stopped";
  (orchestrator as any).agentStateCache.get("agent-1").runtimeState = "not_running";
  const freshWs = makeFakeWs(1);
  seedMachineConnection(orchestrator, "machine-1", freshWs);
  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    capabilities: [],
    runtimes: ["codex"],
    daemonVersion: "1.0.0",
    runningAgents: [],
  } as MachineToServerMessage);
  await flushMicrotasks(10);

  assert.equal(freshWs.sent.length, 0);
  assert.equal(pendingAcks.size, 0);
  orchestrator.shutdown();
});

test("pending direct delivery retry drops after authoritative manual stop", async () => {
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), clock);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  const ws = makeFakeWs(1);
  seedMachineConnection(orchestrator, "machine-1", ws);
  const message = makeAgentMessage("must not cross manual stop boundary", 51);

  await orchestrator.deliverMessage("agent-1", message);
  await flushMicrotasks();

  assert.equal(ws.sent.length, 1);
  (orchestrator as any).agentStateCache.get("agent-1").status = "stopped";
  (orchestrator as any).agentStateCache.get("agent-1").runtimeState = "not_running";

  clock.advance(5_000);
  await flushMicrotasks(10);

  assert.equal(ws.sent.length, 1);
  const pendingAcks = (orchestrator as any).pendingAgentDeliveryAcks as Map<string, unknown>;
  assert.equal(pendingAcks.size, 0);
  orchestrator.shutdown();
});

test("pending direct delivery retry drops when authoritative machine ownership changes", async () => {
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), clock);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  const oldMachine = makeFakeWs(1);
  const newMachine = makeFakeWs(1);
  seedMachineConnection(orchestrator, "machine-1", oldMachine);
  seedMachineConnection(orchestrator, "machine-2", newMachine);
  const message = makeAgentMessage("must not retry to stale machine owner", 52);

  await orchestrator.deliverMessage("agent-1", message);
  await flushMicrotasks();

  assert.equal(oldMachine.sent.length, 1);
  (orchestrator as any).agentStateCache.get("agent-1").machineId = "machine-2";

  clock.advance(5_000);
  await flushMicrotasks(10);

  assert.equal(oldMachine.sent.length, 1);
  assert.equal(newMachine.sent.length, 0);
  const pendingAcks = (orchestrator as any).pendingAgentDeliveryAcks as Map<string, unknown>;
  assert.equal(pendingAcks.size, 0);
  orchestrator.shutdown();
});

test("machine unlink disconnect closes websocket with computer_machine_unlinked reason", async () => {
  const clock = new FakeClock();
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new HeartbeatDeterministicAgentOrchestrator(store, clock);
  const ws = makeFakeWs(1);
  seedMachineConnection(orchestrator, "machine-1", ws);
  store.machineReplicas.add("machine-1");

  const disconnected = await orchestrator.disconnectMachineForUnlink("machine-1");

  assert.equal(disconnected, true);
  assert.deepEqual(ws.closeArgs, [{ code: 4001, reason: "computer_machine_unlinked" }]);
  assert.equal((orchestrator as any).machineConnections.has("machine-1"), false);
  assert.equal(store.machineReplicas.has("machine-1"), false);
  orchestrator.shutdown();
});

test("manual stop clears local pending direct delivery retry registry", async () => {
  const clock = new FakeClock();
  const orchestrator = new StopApplyDeterministicOrchestrator(new InMemoryReplicaStateStore(), clock);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs(1));
  const message = makeAgentMessage("local stop cleanup clears pending retry", 53);

  await orchestrator.deliverMessage("agent-1", message);
  await flushMicrotasks();

  assert.equal(orchestrator.sentToMachine.filter((msg) => msg.type === "agent:deliver").length, 1);
  const pendingAcks = (orchestrator as any).pendingAgentDeliveryAcks as Map<string, unknown>;
  assert.equal(pendingAcks.size, 1);

  await orchestrator.callApplyStopAction("agent-1", "manual");

  assert.equal(pendingAcks.size, 0);
  clock.advance(5_000);
  await flushMicrotasks();

  assert.equal(orchestrator.sentToMachine.filter((msg) => msg.type === "agent:deliver").length, 1);
  orchestrator.shutdown();
});

test("acknowledgeDeliveredMessages drains volatile inbox without advancing legacy read cursor", async () => {
  const orchestrator = new VolatileDeliveryDeterministicOrchestrator();
  const agentId = "agent-1";

  orchestrator.deliverToLocalInbox(agentId, {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "first",
    timestamp: new Date(0).toISOString(),
    seq: 10,
    message_id: "m10",
  });
  orchestrator.deliverToLocalInbox(agentId, {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "second",
    timestamp: new Date(0).toISOString(),
    seq: 12,
    message_id: "m12",
  });
  orchestrator.deliverToLocalInbox(agentId, {
    channel_id: "channel-2",
    channel_name: "random",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "third",
    timestamp: new Date(0).toISOString(),
    seq: 7,
    message_id: "m7",
  });
  orchestrator.deliverToLocalInbox(agentId, {
    channel_id: "channel-2",
    channel_name: "random",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "seq-less",
    timestamp: new Date(0).toISOString(),
    message_id: "m-no-seq",
  });

  orchestrator.acknowledgeDeliveredMessages(agentId, [10, 12, 7]);

  assert.deepEqual(await orchestrator.receiveMessages(agentId, false, 0), [
    {
      channel_id: "channel-2",
      channel_name: "random",
      channel_type: "channel",
      sender_id: "user-1",
      sender_name: "tygg",
      sender_type: "human",
      content: "seq-less",
      timestamp: new Date(0).toISOString(),
      message_id: "m-no-seq",
    },
  ]);
  assert.deepEqual(orchestrator.legacyReadAdvances, []);
  orchestrator.shutdown();
});

test("acknowledgeDeliveredMessagesForChannel removes only the specified target channel", async () => {
  const orchestrator = new VolatileDeliveryDeterministicOrchestrator();
  const agentId = "agent-1";
  const targetMessage: AgentMessage = {
    channel_id: "channel-1",
    channel_name: "focus",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "shown in held notice",
    timestamp: new Date(0).toISOString(),
    seq: 10,
    message_id: "target-10",
  };
  const otherMessage: AgentMessage = {
    channel_id: "channel-2",
    channel_name: "side",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "normal inbox still owns this",
    timestamp: new Date(0).toISOString(),
    seq: 11,
    message_id: "side-11",
  };

  orchestrator.deliverToLocalInbox(agentId, targetMessage);
  orchestrator.deliverToLocalInbox(agentId, otherMessage);

  assert.deepEqual(
    orchestrator.acknowledgeDeliveredMessagesForChannel(agentId, "channel-1", [10, 11]),
    { removedCount: 1 },
  );
  assert.deepEqual(await orchestrator.receiveMessages(agentId, false, 0), [otherMessage]);
  assert.deepEqual(orchestrator.legacyReadAdvances, []);
  orchestrator.shutdown();
});

test("discardUndeliverableMessages drops stale private inbox residue without advancing read cursors", async () => {
  const orchestrator = new VolatileDeliveryDeterministicOrchestrator();
  const agentId = "agent-1";
  const stalePrivate: AgentMessage = {
    channel_id: "private-channel",
    channel_name: "poker-player",
    channel_type: "private",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "private residue after removal",
    timestamp: new Date(0).toISOString(),
    seq: 10,
    message_id: "private-10",
  };
  const visibleMessage: AgentMessage = {
    channel_id: "public-channel",
    channel_name: "all",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "still visible",
    timestamp: new Date(0).toISOString(),
    seq: 11,
    message_id: "public-11",
  };

  orchestrator.deliverToLocalInbox(agentId, stalePrivate);
  orchestrator.deliverToLocalInbox(agentId, visibleMessage);

  assert.deepEqual(
    orchestrator.discardUndeliverableMessages(agentId, [stalePrivate]),
    { removedCount: 1 },
  );
  assert.deepEqual(await orchestrator.receiveMessages(agentId, false, 0), [visibleMessage]);
  assert.deepEqual(orchestrator.legacyReadAdvances, []);
  orchestrator.shutdown();
});

test("purgeAgentInboxForChannels drops channel residue and asks daemon to drain without advancing read cursors", async () => {
  const orchestrator = new PurgeInboxDeterministicOrchestrator();
  const agentId = "agent-1";
  seedActiveAgent(orchestrator, agentId, "machine-1");
  const parentMessage: AgentMessage = {
    channel_id: "private-channel",
    channel_name: "poker-player",
    channel_type: "private",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "private residue",
    timestamp: new Date(0).toISOString(),
    seq: 20,
    message_id: "private-20",
  };
  const threadMessage: AgentMessage = {
    ...parentMessage,
    channel_id: "private-thread",
    channel_name: "thread-private",
    channel_type: "thread",
    parent_channel_id: "private-channel",
    parent_channel_name: "poker-player",
    parent_channel_type: "private",
    content: "thread residue",
    seq: 21,
    message_id: "thread-21",
  };
  const publicMessage: AgentMessage = {
    ...parentMessage,
    channel_id: "public-channel",
    channel_name: "all",
    channel_type: "channel",
    content: "still visible",
    seq: 22,
    message_id: "public-22",
  };

  orchestrator.deliverToLocalInbox(agentId, parentMessage);
  orchestrator.deliverToLocalInbox(agentId, threadMessage);
  orchestrator.deliverToLocalInbox(agentId, publicMessage);

  const result = await orchestrator.purgeAgentInboxForChannels(
    agentId,
    ["private-channel", "private-thread"],
    "channel_membership_removed",
  );

  assert.deepEqual(result, { localRemovedCount: 2, machineSent: true });
  assert.deepEqual(await orchestrator.receiveMessages(agentId, false, 0), [publicMessage]);
  assert.deepEqual(orchestrator.legacyReadAdvances, []);
  assert.equal(orchestrator.sentToMachine.length, 1);
  assert.deepEqual(orchestrator.sentToMachine[0], {
    machineId: "machine-1",
    msg: {
      type: "agent:inbox:purge",
      agentId,
      channelIds: ["private-channel", "private-thread"],
      reason: "channel_membership_removed",
    },
  });
  orchestrator.shutdown();
});

test("purgeAgentInboxForChannelTree includes thread descendants without advancing read cursors", async () => {
  const orchestrator = new PurgeInboxDeterministicOrchestrator();
  const agentId = "agent-1";
  seedActiveAgent(orchestrator, agentId, "machine-1");
  orchestrator.threadChannelIdsByParent.set("private-channel", ["private-thread"]);
  const parentMessage: AgentMessage = {
    channel_id: "private-channel",
    channel_name: "poker-player",
    channel_type: "private",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "private residue",
    timestamp: new Date(0).toISOString(),
    seq: 30,
    message_id: "private-30",
  };
  const threadMessage: AgentMessage = {
    ...parentMessage,
    channel_id: "private-thread",
    channel_name: "thread-private",
    channel_type: "thread",
    parent_channel_id: "private-channel",
    parent_channel_name: "poker-player",
    parent_channel_type: "private",
    content: "thread residue",
    seq: 31,
    message_id: "thread-31",
  };
  const publicMessage: AgentMessage = {
    ...parentMessage,
    channel_id: "public-channel",
    channel_name: "all",
    channel_type: "channel",
    content: "still visible",
    seq: 32,
    message_id: "public-32",
  };

  orchestrator.deliverToLocalInbox(agentId, parentMessage);
  orchestrator.deliverToLocalInbox(agentId, threadMessage);
  orchestrator.deliverToLocalInbox(agentId, publicMessage);

  const result = await orchestrator.purgeAgentInboxForChannelTree(
    agentId,
    "private-channel",
    "channel_membership_removed",
  );

  assert.deepEqual(result, { localRemovedCount: 2, machineSent: true });
  assert.deepEqual(await orchestrator.receiveMessages(agentId, false, 0), [publicMessage]);
  assert.deepEqual(orchestrator.legacyReadAdvances, []);
  assert.equal(orchestrator.sentToMachine.length, 1);
  assert.deepEqual(orchestrator.sentToMachine[0], {
    machineId: "machine-1",
    msg: {
      type: "agent:inbox:purge",
      agentId,
      channelIds: ["private-channel", "private-thread"],
      reason: "channel_membership_removed",
    },
  });
  orchestrator.shutdown();
});

test("acknowledgeDeliveredMessagesForChannelUpToSeq drains target batch without advancing legacy read cursor", async () => {
  const orchestrator = new VolatileDeliveryDeterministicOrchestrator();
  const agentId = "agent-1";
  const targetTen: AgentMessage = {
    channel_id: "channel-1",
    channel_name: "focus",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: "shown in held notice",
    timestamp: new Date(0).toISOString(),
    seq: 10,
    message_id: "target-10",
  };
  const targetEleven: AgentMessage = {
    ...targetTen,
    content: "omitted from bounded held notice",
    seq: 11,
    message_id: "target-11",
  };
  const targetFuture: AgentMessage = {
    ...targetTen,
    content: "future message should remain",
    seq: 13,
    message_id: "target-13",
  };
  const otherMessage: AgentMessage = {
    ...targetTen,
    channel_id: "channel-2",
    channel_name: "side",
    content: "normal inbox still owns this",
    seq: 12,
    message_id: "side-12",
  };

  orchestrator.deliverToLocalInbox(agentId, targetTen);
  orchestrator.deliverToLocalInbox(agentId, targetEleven);
  orchestrator.deliverToLocalInbox(agentId, otherMessage);
  orchestrator.deliverToLocalInbox(agentId, targetFuture);

  assert.deepEqual(
    orchestrator.acknowledgeDeliveredMessagesForChannelUpToSeq(agentId, "channel-1", 11),
    { removedCount: 2 },
  );
  assert.deepEqual(await orchestrator.receiveMessages(agentId, false, 0), [otherMessage, targetFuture]);
  assert.deepEqual(orchestrator.legacyReadAdvances, []);
  orchestrator.shutdown();
});

test("partitionTargetScopedMessagesUpToSeq keeps other channels and newer target messages", () => {
  const targetOld = { channel_id: "target", seq: 1 } as AgentMessage;
  const targetLatest = { channel_id: "target", seq: 2 } as AgentMessage;
  const targetFuture = { channel_id: "target", seq: 3 } as AgentMessage;
  const side = { channel_id: "side", seq: 2 } as AgentMessage;

  assert.deepEqual(
    partitionTargetScopedMessagesUpToSeq({
      inbox: [targetOld, targetLatest, targetFuture, side],
      channelId: "target",
      maxSeq: 2,
    }),
    {
      removed: [targetOld, targetLatest],
      retained: [targetFuture, side],
    },
  );
});

// --- deliverMessage sendToMachine error path ---

test("best-effort send primitive swallows injected send failures", async () => {
  const registry = new InMemoryFailpointRegistry();
  const orchestrator = new SendPrimitiveHarness();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;

  registry.configure("server.agentOrchestrator.sendToMachine.dispatch", {
    effect: "throw",
    payload: "send failed",
    mode: "once",
  });
  __setFailpointsForTests(registry);
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    orchestrator.callBestEffortSend();
    await flushMicrotasks();
  } finally {
    console.warn = originalWarn;
    __resetFailpointsForTests();
    orchestrator.shutdown();
  }

  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.[0] ?? ""), /best-effort send failed/);
});

test("applySendToMachineAction sends locally without reroute when the planner says send-locally", async () => {
  const orchestrator = new SendToMachineApplyDeterministicOrchestrator();

  const { delivered } = await orchestrator.callApplySendToMachineAction("send-locally");

  assert.equal(delivered, true);
  assert.deepEqual(orchestrator.calls, ["local"]);
  orchestrator.shutdown();
});

test("applySendToMachineAction short-circuits after a successful reroute", async () => {
  const orchestrator = new SendToMachineApplyDeterministicOrchestrator();

  const { delivered } = await orchestrator.callApplySendToMachineAction("reroute-then-warn", true);

  assert.equal(delivered, true);
  assert.deepEqual(orchestrator.calls, ["reroute"]);
  orchestrator.shutdown();
});

test("applySendToMachineAction warns offline when reroute does not succeed", async () => {
  const orchestrator = new SendToMachineApplyDeterministicOrchestrator();

  const { delivered } = await orchestrator.callApplySendToMachineAction("reroute-then-warn", false);

  assert.equal(delivered, false);
  assert.deepEqual(orchestrator.calls, ["reroute"]);
  orchestrator.shutdown();
});

test("applySendToMachineAction exposes owner-plane diagnostics for no-receiver reroutes", async () => {
  const orchestrator = new SendToMachineApplyDeterministicOrchestrator();

  const { delivered, observedRouteResult } = await orchestrator.callApplySendToMachineAction("reroute-then-warn", {
    routed: false,
    reason: "publish_no_receivers",
    ownerReplicaPresent: true,
    ownerReplicaCurrent: false,
    ownerReplicaTtlSeconds: 287,
    ownerReplicaAgeMs: 13000,
    ownerCohort: "aws",
    ownerRequestHostClass: "direct",
    ownerRequestHostPresent: true,
    receiverPresent: false,
    receiverKind: "none",
    receiverReplicaCurrent: false,
    publishReceivers: 0,
    staleOwnerCleanupResult: "not_attempted",
    staleOwnerCleanupReason: "publish_no_receivers",
  });

  assert.equal(delivered, false);
  assert.deepEqual(orchestrator.calls, ["reroute"]);
  assert.deepEqual(observedRouteResult, {
    routed: false,
    reason: "publish_no_receivers",
    ownerReplicaPresent: true,
    ownerReplicaCurrent: false,
    ownerReplicaTtlSeconds: 287,
    ownerReplicaAgeMs: 13000,
    ownerCohort: "aws",
    ownerRequestHostClass: "direct",
    ownerRequestHostPresent: true,
    receiverPresent: false,
    receiverKind: "none",
    receiverReplicaCurrent: false,
    publishReceivers: 0,
    staleOwnerCleanupResult: "not_attempted",
    staleOwnerCleanupReason: "publish_no_receivers",
  });
  assert.deepEqual(projectMachineCommandRouteTraceAttrs(observedRouteResult), {
    router_reason: "publish_no_receivers",
    router_routed: false,
    owner_replica_present: true,
    owner_replica_current: false,
    owner_replica_ttl_seconds: 287,
    owner_replica_age_ms: 13000,
    receiver_present: false,
    receiver_kind: "none",
    receiver_replica_current: false,
    publish_receivers: 0,
    stale_owner_cleanup_result: "not_attempted",
    stale_owner_cleanup_reason: "publish_no_receivers",
  });
  orchestrator.shutdown();
});

test("machine command route trace projection exposes stale owner cleanup result", () => {
  assert.deepEqual(projectMachineCommandRouteTraceAttrs({
    routed: false,
    reason: "publish_no_receivers",
    ownerReplicaPresent: true,
    ownerReplicaCurrent: false,
    ownerReplicaTtlSeconds: 211,
    ownerReplicaAgeMs: 89_000,
    receiverPresent: false,
    receiverKind: "none",
    receiverReplicaCurrent: false,
    publishReceivers: 0,
    staleOwnerCleanupResult: "deleted",
    staleOwnerCleanupReason: "publish_no_receivers",
  }), {
    router_reason: "publish_no_receivers",
    router_routed: false,
    owner_replica_present: true,
    owner_replica_current: false,
    owner_replica_ttl_seconds: 211,
    owner_replica_age_ms: 89_000,
    receiver_present: false,
    receiver_kind: "none",
    receiver_replica_current: false,
    publish_receivers: 0,
    stale_owner_cleanup_result: "deleted",
    stale_owner_cleanup_reason: "publish_no_receivers",
  });
});

test("sendToMachine route trace emits closed owner-gap and cleanup reasons", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const missingOwnerStore = new InMemoryReplicaStateStore();
  const missingOwner = new RouteTraceSendPrimitiveHarness({
    routed: false,
    reason: "owner_missing",
    ownerReplicaPresent: false,
    ownerReplicaCurrent: false,
    receiverPresent: false,
    receiverKind: "none",
    receiverReplicaCurrent: false,
  }, missingOwnerStore, tracer);
  await assert.rejects(() => missingOwner.callRequiredSend("machine offline"), /machine offline/);

  const staleCleanupStore = new InMemoryReplicaStateStore();
  const staleCleanup = new RouteTraceSendPrimitiveHarness({
    routed: false,
    reason: "publish_no_receivers",
    ownerReplicaPresent: true,
    ownerReplicaCurrent: false,
    ownerReplicaTtlSeconds: 211,
    ownerReplicaAgeMs: 89_000,
    receiverPresent: false,
    receiverKind: "none",
    receiverReplicaCurrent: false,
    publishReceivers: 0,
    staleOwnerCleanupResult: "deleted",
    staleOwnerCleanupReason: "publish_no_receivers",
  }, staleCleanupStore, tracer);
  await assert.rejects(() => staleCleanup.callRequiredSend("machine offline"), /machine offline/);

  const routeRows = sink.getTrace(traceId)
    .filter((entry) => entry.name === "server.machine.command.route")
    .flatMap((entry) => traceEventRowsForSpan(entry, TRACE_EVENT_ROW_TEST_RESOURCE));
  assert.equal(routeRows.length, 2);
  assert.equal(routeRows[0]?.event_name, "machine.command.route");
  assert.equal(routeRows[0]?.machine_id, "machine-1");
  assert.equal(routeRows[0]?.router_reason, "owner_missing");
  assert.equal(routeRows[0]?.reason, "owner_missing");
  assert.equal(routeRows[0]?.stale_owner_cleanup_result, null);
  assert.equal(routeRows[1]?.machine_id, "machine-1");
  assert.equal(routeRows[1]?.router_reason, "publish_no_receivers");
  assert.equal(routeRows[1]?.stale_owner_cleanup_result, "deleted");
  assert.equal(routeRows[1]?.stale_owner_cleanup_reason, "publish_no_receivers");

  missingOwner.shutdown();
  staleCleanup.shutdown();
});

test("stale owner cleanup only targets aged owner mappings", () => {
  assert.equal(shouldCleanupStaleMachineOwner(undefined), false);
  assert.equal(shouldCleanupStaleMachineOwner(15_000), false);
  assert.equal(shouldCleanupStaleMachineOwner(59_999), false);
  assert.equal(shouldCleanupStaleMachineOwner(60_000), true);
  assert.equal(shouldCleanupStaleMachineOwner(120_000), true);
});

test("machine command route trace projection exposes cross-replica publish success diagnostics", () => {
  assert.deepEqual(projectMachineCommandRouteTraceAttrs({
    routed: true,
    reason: "published",
    ownerReplicaPresent: true,
    ownerReplicaCurrent: false,
    ownerReplicaTtlSeconds: 292,
    ownerReplicaAgeMs: 8000,
    receiverPresent: true,
    receiverKind: "pubsub_subscriber",
    receiverReplicaCurrent: false,
    publishReceivers: 1,
  }), {
    router_reason: "published",
    router_routed: true,
    owner_replica_present: true,
    owner_replica_current: false,
    owner_replica_ttl_seconds: 292,
    owner_replica_age_ms: 8000,
    receiver_present: true,
    receiver_kind: "pubsub_subscriber",
    receiver_replica_current: false,
    publish_receivers: 1,
  });
});

test("required send primitive throws when the machine is not routable", async () => {
  const registry = new InMemoryFailpointRegistry();
  const orchestrator = new SendPrimitiveHarness();

  registry.configure("server.agentOrchestrator.sendToMachine.dispatch", {
    effect: "return",
    payload: false,
    mode: "once",
  });
  __setFailpointsForTests(registry);
  try {
    await assert.rejects(() => orchestrator.callRequiredSend("machine offline"), /machine offline/);
  } finally {
    __resetFailpointsForTests();
    orchestrator.shutdown();
  }
});

test("deliverMessage does not recreate a local inbox after the agent is manually stopped during route fallback", async () => {
  const orchestrator = new DeferredLocalFallbackDeliverMessageOrchestrator();
  seedActiveAgent(orchestrator);
  const message = makeAgentMessage("late local fallback after stop");

  const deliverPromise = orchestrator.deliverMessage("agent-1", message);
  await waitForCondition(() => orchestrator.routeEntered);
  assert.equal(orchestrator.routeEntered, true);

  await orchestrator.stopAgent("agent-1");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "stopped");
  assert.equal((orchestrator as any).agentInboxes.has("agent-1"), false);

  orchestrator.routeGate.resolve(false);
  await deliverPromise;

  assert.equal((orchestrator as any).agentInboxes.has("agent-1"), false);
  orchestrator.shutdown();
});

test("routed inbox delivery does not recreate a local inbox after the agent is manually stopped during reroute fallback", async () => {
  const orchestrator = new DeferredLocalFallbackDeliverMessageOrchestrator();
  seedActiveAgent(orchestrator);
  const message = makeAgentMessage("late routed fallback after stop");

  const deliverPromise = orchestrator.handleRoutedInboxDelivery("agent-1", "machine-1", message);
  await flushMicrotasks();
  assert.equal(orchestrator.routeEntered, true);

  await orchestrator.stopAgent("agent-1");
  assert.equal((orchestrator as any).agentStateCache.get("agent-1").status, "stopped");
  assert.equal((orchestrator as any).agentInboxes.has("agent-1"), false);

  orchestrator.routeGate.resolve(false);
  await deliverPromise;

  assert.equal((orchestrator as any).agentInboxes.has("agent-1"), false);
  orchestrator.shutdown();
});

// --- Passive scope gate (#proj-permission:1414ca65) ---

test("deliverMessage returns a typed drop when the target agent is unavailable", async () => {
  const orchestrator = new DeterministicAgentOrchestrator();

  const result = await orchestrator.deliverMessage("missing-agent", makeAgentMessage("missing target"));

  assert.deepEqual(result, { status: "dropped", reason: "agent_unavailable" });
  orchestrator.shutdown();
});

class ScopeRevokedDeliverMessageOrchestrator extends DeterministicAgentOrchestrator {
  readonly hasPassiveDeliveryScopeCalls: string[] = [];
  scopeAllowed = false;

  protected override async hasPassiveDeliveryScope(agentId: string): Promise<boolean> {
    this.hasPassiveDeliveryScopeCalls.push(agentId);
    return this.scopeAllowed;
  }
}

class TargetVisibilityGateOrchestrator extends DeterministicAgentOrchestrator {
  readonly accessChecks: Array<{ agentId: string; channelId: string }> = [];
  readonly sentToMachine: Array<{ machineId: string; msg: ServerToMachineMessage }> = [];
  canAccess = false;

  protected override async canAgentAccessDeliveryTarget(agentId: string, _agent: any, message: AgentMessage): Promise<boolean> {
    this.accessChecks.push({ agentId, channelId: message.channel_id });
    return this.canAccess;
  }

  protected override async sendToMachine(machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    this.sentToMachine.push({ machineId, msg });
    return true;
  }
}

test("deliverMessage drops the message when the agent lacks inbox:receive scope", async () => {
  const orchestrator = new ScopeRevokedDeliverMessageOrchestrator();
  seedActiveAgent(orchestrator);
  const message = makeAgentMessage("revoked passive scope drops push");

  const result = await orchestrator.deliverMessage("agent-1", message);

  assert.deepEqual(result, { status: "dropped", reason: "passive_scope_revoked" });
  assert.deepEqual(orchestrator.hasPassiveDeliveryScopeCalls, ["agent-1"]);
  assert.equal((orchestrator as any).agentInboxes.has("agent-1"), false);
  orchestrator.shutdown();
});

test("deliverMessage with intrinsic option bypasses the passive scope gate", async () => {
  const orchestrator = new ScopeRevokedDeliverMessageOrchestrator();
  seedActiveAgent(orchestrator);
  const message = makeAgentMessage("intrinsic delivery bypasses revoked scope");

  const result = await orchestrator.deliverMessage("agent-1", message, { intrinsic: true });

  assert.deepEqual(result, { status: "queued", reason: "replayable_inbox" });
  // hasPassiveDeliveryScope is never even consulted for intrinsic deliveries.
  assert.deepEqual(orchestrator.hasPassiveDeliveryScopeCalls, []);
  orchestrator.shutdown();
});

test("deliverMessage with admin authority bypasses the passive scope gate", async () => {
  const orchestrator = new ScopeRevokedDeliverMessageOrchestrator();
  seedActiveAgent(orchestrator);
  const message = makeAgentMessage("owner/admin delivery bypasses revoked scope");

  const result = await orchestrator.deliverMessage("agent-1", message, { adminAuthority: true });

  assert.deepEqual(result, { status: "queued", reason: "replayable_inbox" });
  assert.deepEqual(orchestrator.hasPassiveDeliveryScopeCalls, []);
  orchestrator.shutdown();
});

test("deliverMessage drops ordinary unreadable targets even with admin authority", async () => {
  const orchestrator = new TargetVisibilityGateOrchestrator();
  seedActiveAgent(orchestrator);
  const message = makeAgentMessage("private message after membership removal", 55);
  message.channel_id = "private-channel";
  message.channel_name = "poker-player";
  message.channel_type = "private";

  const result = await orchestrator.deliverMessage("agent-1", message, { adminAuthority: true });

  assert.deepEqual(result, { status: "dropped", reason: "target_access_changed" });
  assert.deepEqual(orchestrator.accessChecks, [{ agentId: "agent-1", channelId: "private-channel" }]);
  assert.equal((orchestrator as any).agentInboxes.has("agent-1"), false);
  assert.equal(orchestrator.sentToMachine.length, 0);
  orchestrator.shutdown();
});

test("intrinsic delivery bypasses target visibility guard", async () => {
  const orchestrator = new TargetVisibilityGateOrchestrator();
  seedActiveAgent(orchestrator);
  const message = makeAgentMessage("intrinsic control message", 56);
  message.channel_id = "private-channel";
  message.channel_name = "poker-player";
  message.channel_type = "private";

  await orchestrator.deliverMessage("agent-1", message, { intrinsic: true });

  assert.deepEqual(orchestrator.accessChecks, []);
  assert.equal((orchestrator as any).agentInboxes.get("agent-1")?.inbox.length, 1);
  assert.equal(orchestrator.sentToMachine.length, 1);
  orchestrator.shutdown();
});

test("routed inbox delivery drops unreadable targets before local fallback", async () => {
  const orchestrator = new TargetVisibilityGateOrchestrator();
  seedActiveAgent(orchestrator);
  const message = makeAgentMessage("routed private residue", 57);
  message.channel_id = "private-channel";
  message.channel_name = "poker-player";
  message.channel_type = "private";

  const handled = await orchestrator.handleRoutedInboxDelivery("agent-1", "machine-1", message);

  assert.equal(handled, true);
  assert.deepEqual(orchestrator.accessChecks, [{ agentId: "agent-1", channelId: "private-channel" }]);
  assert.equal((orchestrator as any).agentInboxes.has("agent-1"), false);
  orchestrator.shutdown();
});

test("deliverMessage swallows fire-and-forget send errors and still delivers to the local inbox", async () => {
  const registry = new InMemoryFailpointRegistry();
  const orchestrator = new DeterministicAgentOrchestrator();
  seedActiveAgent(orchestrator);
  const message = makeAgentMessage("unobserved send failure");

  registry.configure("server.agentOrchestrator.sendToMachine.dispatch", {
    effect: "throw",
    payload: "send failed",
    mode: "once",
  });
  __setFailpointsForTests(registry);
  try {
    const result = await orchestrator.deliverMessage("agent-1", message);
    assert.deepEqual(result, { status: "queued", reason: "replayable_inbox" });
    const inbox = (orchestrator as any).agentInboxes.get("agent-1");
    assert.ok(inbox);
    assert.deepEqual(inbox.inbox, [message]);
  } finally {
    __resetFailpointsForTests();
    orchestrator.shutdown();
  }
});

// --- Activity probe / seq dedup (#engineering:72283cf7 task #340 PR B) ---

test("sweep with connected machine sends agent:activity_probe and skips synth", async () => {
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore());
  const ws = makeFakeWs();
  seedMachineConnection(orchestrator, "machine-1", ws);
  seedActiveAgent(orchestrator);
  // Make the agent stale.
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "stuck",
    updatedAt: Date.now() - 91_000,
  });

  (orchestrator as any).sweepStaleActivities();
  // Allow the async probe-issue path to flush.
  await new Promise((resolve) => setImmediate(resolve));

  // The activity hasn't been flipped to online — sweep deferred to probe.
  assert.equal((orchestrator as any).agentActivity.get("agent-1").activity, "working");
  // A probe message was sent over the WS.
  const probeMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === "agent:activity_probe");
  assert.ok(probeMsg, "expected agent:activity_probe to be sent");
  assert.equal(probeMsg.agentId, "agent-1");
  assert.equal(probeMsg.purpose, "sweep");
  assert.equal(typeof probeMsg.probeId, "string");
  // Probe is tracked as pending.
  assert.equal((orchestrator as any).pendingActivityProbes.size, 1);
  orchestrator.shutdown();
});

test("probe timeout preserves stale busy activity without reauthoring its clock or detail", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let probeTimeout: (() => void) | null = null;
  (globalThis as any).setTimeout = ((callback: () => void, ms?: number, ...args: any[]) => {
    if (ms === 5_000) {
      probeTimeout = callback;
      return { probeTimeout: true };
    }
    return realSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout;
  (globalThis as any).clearTimeout = ((timer: unknown) => {
    if ((timer as any)?.probeTimeout) return;
    return realClearTimeout(timer as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout;

  try {
    const clock = new FakeClock();
    const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), clock);
    const ws = makeFakeWs();
    seedMachineConnection(orchestrator, "machine-1", ws);
    seedActiveAgent(orchestrator);
    const staleAt = clock.now() - 91_000;
    (orchestrator as any).agentActivity.set("agent-1", {
      activity: "working",
      detail: "Running command...",
      detailKind: "running_command",
      updatedAt: staleAt,
    });

    (orchestrator as any).sweepStaleActivities();
    await new Promise((resolve) => setImmediate(resolve));
    const capturedProbeTimeout = probeTimeout as (() => void) | null;
    assert.ok(capturedProbeTimeout, "probe fallback timer should be armed");
    capturedProbeTimeout();

    assert.equal((orchestrator as any).pendingActivityProbes.size, 0);
    assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), {
      activity: "working",
      detail: "Running command...",
      detailKind: "running_command",
      updatedAt: staleAt,
    });

    orchestrator.shutdown();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("daemon probe response cancels the synth fallback timer", async () => {
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore());
  const ws = makeFakeWs();
  seedMachineConnection(orchestrator, "machine-1", ws);
  seedActiveAgent(orchestrator);
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "stuck",
    updatedAt: Date.now() - 91_000,
  });

  (orchestrator as any).sweepStaleActivities();
  await new Promise((resolve) => setImmediate(resolve));

  const probeMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === "agent:activity_probe");
  assert.ok(probeMsg);

  // Daemon replies via the existing agent:activity channel with matching probeId.
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "still busy",
    probeId: probeMsg.probeId,
  } as MachineToServerMessage);

  // pending probe is cleared (fallback won't fire).
  assert.equal((orchestrator as any).pendingActivityProbes.size, 0);
  orchestrator.shutdown();
});

test("ingest dedup drops agent:activity with stale clientSeq for same launchId", async () => {
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore());
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  seedActiveAgent(orchestrator);

  // Seq 5 — accepted, becomes lastSeen.
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "first",
    launchId: "launch-A",
    clientSeq: 5,
  } as MachineToServerMessage);
  assert.equal((orchestrator as any).agentActivity.get("agent-1").activity, "working");
  assert.equal((orchestrator as any).agentActivity.get("agent-1").detail, "first");

  // Seq 3 — late-arriving older message, must be dropped.
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "online",
    detail: "stale-late",
    launchId: "launch-A",
    clientSeq: 3,
  } as MachineToServerMessage);
  assert.equal((orchestrator as any).agentActivity.get("agent-1").detail, "first", "stale clientSeq should not overwrite");

  // Seq 6 — newer than 5 → applied.
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "online",
    detail: "fresh-newer",
    launchId: "launch-A",
    clientSeq: 6,
  } as MachineToServerMessage);
  assert.equal((orchestrator as any).agentActivity.get("agent-1").detail, "fresh-newer");

  // New launchId → seq tracking resets, so seq 1 of a new launch is accepted
  // even though we just saw seq 6 of the previous launch.
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "new-launch-seq-1",
    launchId: "launch-B",
    clientSeq: 1,
  } as MachineToServerMessage);
  assert.equal((orchestrator as any).agentActivity.get("agent-1").detail, "new-launch-seq-1");

  orchestrator.shutdown();
});

test("ingest dedup re-baselines clientSeq only when the daemon process identity changes", async () => {
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore());
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  seedActiveAgent(orchestrator);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "old-daemon-high-watermark",
    daemonInstanceId: "daemon-old",
    clientSeq: 7_983,
  } as MachineToServerMessage);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "thinking",
    detail: "same-daemon-reconnect-replay",
    daemonInstanceId: "daemon-old",
    clientSeq: 213,
  } as MachineToServerMessage);
  assert.equal(
    (orchestrator as any).agentActivity.get("agent-1").detail,
    "old-daemon-high-watermark",
    "a WS reconnect from the same daemon process must retain replay dedup",
  );

  for (const [clientSeq, activity, detail] of [
    [213, "working", "new-daemon-working"],
    [214, "thinking", "new-daemon-thinking"],
    [215, "error", "new-daemon-error"],
  ] as const) {
    await orchestrator.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      activity,
      detail,
      daemonInstanceId: "daemon-new",
      clientSeq,
    } as MachineToServerMessage);
    assert.equal((orchestrator as any).agentActivity.get("agent-1").activity, activity);
    assert.equal(
      (orchestrator as any).agentActivity.get("agent-1").detail,
      detail,
      "every post-restart activity transition must enter the new sequence generation",
    );
  }

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "online",
    detail: "new-daemon-duplicate",
    daemonInstanceId: "daemon-new",
    clientSeq: 214,
  } as MachineToServerMessage);
  assert.equal(
    (orchestrator as any).agentActivity.get("agent-1").detail,
    "new-daemon-error",
    "same-generation duplicates must still be dropped after daemon restart recovery",
  );

  orchestrator.shutdown();
});

test("ingest dedup still rejects replay and reordering within one daemon process generation", async () => {
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore());
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  seedActiveAgent(orchestrator);

  for (const [clientSeq, detail] of [
    [215, "accepted-high-watermark"],
    [214, "reordered-older"],
    [215, "replayed-same-sequence"],
  ] as const) {
    await orchestrator.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      activity: "working",
      detail,
      daemonInstanceId: "daemon-same",
      clientSeq,
    } as MachineToServerMessage);
  }

  assert.equal(
    (orchestrator as any).agentActivity.get("agent-1").detail,
    "accepted-high-watermark",
  );
  assert.equal(
    (orchestrator as any).lastClientSeqByActivityIngestKey.get(
      "agent-1:daemon:daemon-same:launch:legacy",
    ),
    215,
  );

  orchestrator.shutdown();
});

test("ingest dedup bounds retained daemon process generations per agent", async () => {
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore());
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  seedActiveAgent(orchestrator);

  for (let generation = 1; generation <= 6; generation += 1) {
    await orchestrator.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      activity: "working",
      detail: `generation-${generation}`,
      daemonInstanceId: `daemon-${generation}`,
      clientSeq: 1,
    } as MachineToServerMessage);
  }

  assert.deepEqual(
    (orchestrator as any).activityDaemonGenerationsByAgent.get("agent-1"),
    ["daemon-3", "daemon-4", "daemon-5", "daemon-6"],
  );
  const retainedKeys = [...(orchestrator as any).lastClientSeqByActivityIngestKey.keys()]
    .filter((key: string) => key.startsWith("agent-1:daemon:"));
  assert.equal(retainedKeys.length, 4);
  assert.equal(retainedKeys.some((key: string) => key.includes(":daemon-1:")), false);
  assert.equal(retainedKeys.some((key: string) => key.includes(":daemon-2:")), false);

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "error",
    detail: "evicted-generation-is-a-new-observation",
    daemonInstanceId: "daemon-1",
    clientSeq: 1,
  } as MachineToServerMessage);
  assert.equal(
    (orchestrator as any).agentActivity.get("agent-1").detail,
    "evicted-generation-is-a-new-observation",
    "an evicted generation has no retained watermark; the no-cross-process-outbox contract prevents replay",
  );
  assert.deepEqual(
    (orchestrator as any).activityDaemonGenerationsByAgent.get("agent-1"),
    ["daemon-4", "daemon-5", "daemon-6", "daemon-1"],
  );

  orchestrator.shutdown();
});

test("ingest dedup re-baselines clientSeq after a server-controlled start generation", async () => {
  const orchestrator = new StartRoutingMismatchDeterministicOrchestrator();
  const ws = makeFakeWs();
  seedMachineConnection(orchestrator, "machine-1", ws, "0.30.0");
  seedActiveAgent(orchestrator);

  // Previous runtime generation: launch identity may be absent or reused on
  // legacy daemons, so the server-owned generation boundary is the only reliable
  // re-baseline signal.
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "pre-start-high-seq",
    launchId: "launch-A",
    clientSeq: 7,
  } as MachineToServerMessage);
  assert.equal((orchestrator as any).agentActivity.get("agent-1").detail, "pre-start-high-seq");

  await orchestrator.startAgent("agent-1");
  const startMessage = ws.sent.map((raw) => JSON.parse(raw)).find((msg) => msg.type === "agent:start");
  assert.ok(startMessage, "expected the server-controlled start to reach the daemon");
  assert.equal(startMessage.launchId, undefined, "pre-launch-guard daemon should use the legacy/no-launch path");

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "thinking",
    detail: "post-start-reset-seq",
    clientSeq: 1,
  } as MachineToServerMessage);
  assert.equal((orchestrator as any).agentActivity.get("agent-1").activity, "thinking");
  assert.equal((orchestrator as any).agentActivity.get("agent-1").detail, "post-start-reset-seq");

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "online",
    detail: "same-generation-duplicate",
    clientSeq: 1,
  } as MachineToServerMessage);
  assert.equal((orchestrator as any).agentActivity.get("agent-1").detail, "post-start-reset-seq",
    "same-generation duplicate clientSeq must still be dropped after re-baseline");

  orchestrator.shutdown();
});

test("ingest dedup re-baselines no-launch clientSeq after an internal restart boundary", async () => {
  const orchestrator = new StopApplyDeterministicOrchestrator();
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs(), "0.30.0");
  seedActiveAgent(orchestrator);

  // Legacy/no-launch runtime generation climbs to a high watermark.
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "pre-restart-high-seq",
    clientSeq: 117,
  } as MachineToServerMessage);
  assert.equal((orchestrator as any).agentActivity.get("agent-1").detail, "pre-restart-high-seq");

  await orchestrator.callApplyStopAction("agent-1", "internal");
  (orchestrator as any).agentStateCache.get("agent-1").status = "active";

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "thinking",
    detail: "post-restart-reset-seq",
    clientSeq: 56,
  } as MachineToServerMessage);
  assert.equal((orchestrator as any).agentActivity.get("agent-1").activity, "thinking");
  assert.equal((orchestrator as any).agentActivity.get("agent-1").detail, "post-restart-reset-seq");

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "online",
    detail: "same-generation-duplicate",
    clientSeq: 56,
  } as MachineToServerMessage);
  assert.equal((orchestrator as any).agentActivity.get("agent-1").detail, "post-restart-reset-seq",
    "same-generation duplicate clientSeq must still be dropped after no-launch re-baseline");

  orchestrator.shutdown();
});

test("ingest dedup accepts monotonically continued clientSeq across a self-restart that reuses launchId (per-lifetime dedup clock — RS-012)", async () => {
  // Server-side half of the error->restart activity-stops fix (#proj-o11y:a1e54b59,
  // PR #2607). RS-012 separates launch identity from the dedup clock: a daemon
  // self-restart re-materializes the SAME (un-superseded) launch, so it correctly
  // REUSES launchId; the dedup clock must stay per-process-lifetime monotonic and
  // never reset. This test pins the server contract that makes that work — under a
  // reused launchId, an ever-increasing clientSeq is always accepted, so the agent's
  // post-restart working/thinking are NOT dropped by ingest dedup.
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore());
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  seedActiveAgent(orchestrator);

  // Pre-restart activity under the (server-issued) launch — clientSeq climbs to 7.
  for (const [clientSeq, detail] of [[5, "pre-a"], [6, "pre-b"], [7, "pre-c"]] as const) {
    await orchestrator.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      activity: "working",
      detail,
      launchId: "launch-A",
      clientSeq,
    } as MachineToServerMessage);
  }
  assert.equal((orchestrator as any).agentActivity.get("agent-1").detail, "pre-c");

  // Daemon self-restart: the runtime process is recreated but this is the same
  // un-superseded launch, so launchId is REUSED. With the per-lifetime monotonic
  // dedup clock (PR #2607), clientSeq CONTINUES (8, 9) rather than resetting.
  // These must be accepted so working/thinking resume updating.
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "thinking",
    detail: "post-restart-thinking",
    launchId: "launch-A",
    clientSeq: 8,
  } as MachineToServerMessage);
  assert.equal((orchestrator as any).agentActivity.get("agent-1").activity, "thinking");
  assert.equal((orchestrator as any).agentActivity.get("agent-1").detail, "post-restart-thinking",
    "monotonically continued clientSeq under reused launchId must be accepted after a self-restart");

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "post-restart-working",
    launchId: "launch-A",
    clientSeq: 9,
  } as MachineToServerMessage);
  assert.equal((orchestrator as any).agentActivity.get("agent-1").detail, "post-restart-working");

  // Why the daemon clock MUST NOT reset: a post-restart frame that reset clientSeq
  // to 1 under the reused launchId (the pre-fix bug shape) is dropped as stale,
  // which is exactly the "working/thinking stop updating" symptom. Replay/rollback
  // protection is preserved.
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "online",
    detail: "reset-to-1-would-be-dropped",
    launchId: "launch-A",
    clientSeq: 1,
  } as MachineToServerMessage);
  assert.equal((orchestrator as any).agentActivity.get("agent-1").detail, "post-restart-working",
    "a reset (non-monotonic) clientSeq under the reused launchId is dropped — this is why the dedup clock must stay monotonic");

  orchestrator.shutdown();
});

// ===========================================================================
// Cache-Coherence Contract conformance (INV-CC-*)
// ---------------------------------------------------------------------------
// Source: Cache-Coherence Contract v0.1.1 (#contracts:d5eff1af, #proj-o11y).
// These tests turn the four contract invariants from prose into an executable
// gate: any change that violates the contract fails here loudly. The behavioural
// fixes that established them live in #2596/#2597/#2601/#2605; this suite names
// and pins the invariants directly so future drift is caught.
//   INV-CC-FRESH        — a non-owner read never returns a value older than the
//                         latest value committed to Redis by the owner (no
//                         process-lifetime local shadow preferred over Redis).
//   INV-CC-OWNER        — an owner's local read equals what it wrote-through to
//                         Redis.
//   INV-CC-CONVERGE     — a dropped/missed realtime push never leaves a
//                         permanently-wrong status; a pull converges to the
//                         owner's committed value.
//   INV-CC-REJECT-SIDEFX — a rejected (stale) event produces no side effects.
// The frontend half of INV-CC-REJECT-SIDEFX (a stale machine:status `offline`
// not force-offlining agents, #2597) is pinned in packages/web/tests/
// machineStatusRecovery.test.ts.
// ===========================================================================

test("Cache-Coherence INV-CC-FRESH: non-owner read returns the Redis value, never a timestamp-newer local shadow", async () => {
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new DeterministicAgentOrchestrator(store);
  // Agent is assigned to machine-1, which is running on ANOTHER replica:
  // reachable cross-replica (so the reachability gate does not force offline),
  // but NOT connected to THIS replica → this replica is a NON-owner with zero
  // local authority.
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  store.machineReplicas.add("machine-1"); // reachable via the remote owner replica

  // Owner (another replica) committed "working" to the Redis mirror.
  await store.setAgentActivity("agent-1", "working", "owner-truth", "other");
  // A stale local shadow exists AND is timestamp-NEWER than Redis — exactly the
  // A.3 vector. It must NOT mask the owner's authoritative value.
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "thinking",
    detail: "newer-but-shadow",
    updatedAt: Date.now() + 60_000,
  });

  const resolved = await orchestrator.getActivity("agent-1");
  assert.equal(resolved.activity, "working",
    "non-owner must read-through Redis; a timestamp-newer local shadow has no authority");

  orchestrator.shutdown();
});

test("Cache-Coherence INV-CC-FRESH (degraded): non-owner with Redis unavailable falls through to durable/derived, never the local shadow", async () => {
  const store = new RedisUnavailableReplicaStateStore();
  const orchestrator = new DeterministicAgentOrchestrator(store);
  seedActiveAgent(orchestrator, "agent-1", "machine-1"); // non-owner (no local machine connection)

  // Even with a present local shadow, Redis-unavailable must NOT fall back to it.
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "thinking",
    detail: "shadow-under-redis-down",
    updatedAt: Date.now() + 60_000,
  });

  const resolved = await orchestrator.getActivity("agent-1");
  // No durable log / live machine in this harness → derives to offline; the
  // point is it is NOT the local shadow's "thinking".
  assert.notEqual(resolved.activity, "thinking",
    "Redis-down non-owner must pass through to durable/derived, never the local shadow");

  orchestrator.shutdown();
});

test("Cache-Coherence INV-CC-OWNER: an owner's local read equals what it wrote-through to Redis", async () => {
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new DeterministicAgentOrchestrator(store);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs()); // machine local → this replica owns the agent

  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "live",
    clientSeq: 1,
  } as MachineToServerMessage);

  // Owner local cache holds the value...
  assert.equal((orchestrator as any).agentActivity.get("agent-1").activity, "working");
  // ...and it was written-through to Redis identically (CC-003 write-through).
  const mirrored = await store.getAgentActivity("agent-1");
  assert.equal(mirrored?.activity, "working", "owner must write-through to Redis");
  assert.equal(mirrored?.detail, "live");
  // ...and the owner's getActivity returns its authoritative local value.
  assert.equal((await orchestrator.getActivity("agent-1")).activity, "working");

  orchestrator.shutdown();
});

test("Cache-Coherence INV-CC-CONVERGE: a non-owner that missed the realtime push converges to the owner's committed value via pull", async () => {
  // Shared Redis mirror between an owner replica and a non-owner replica.
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1"); // agent's machine is reachable cross-replica
  const owner = new DeterministicAgentOrchestrator(store);
  seedActiveAgent(owner, "agent-1", "machine-1");
  seedMachineConnection(owner, "machine-1", makeFakeWs());
  // Owner intentionally has NO io set → the realtime push is dropped on the floor.
  await owner.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "committed-no-push",
    clientSeq: 1,
  } as MachineToServerMessage);

  // A non-owner replica that never received any push (empty local cache) still
  // converges to the owner-committed value by pulling the shared Redis source.
  const nonOwner = new DeterministicAgentOrchestrator(store);
  seedActiveAgent(nonOwner, "agent-1", "machine-1"); // knows the agent; machine not local → non-owner
  assert.equal((nonOwner as any).agentActivity.get("agent-1"), undefined, "non-owner has no local push state");
  assert.equal((await nonOwner.getActivity("agent-1")).activity, "working",
    "pull converges to owner-committed value even though the realtime push was dropped");

  owner.shutdown();
  nonOwner.shutdown();
});

test("Cache-Coherence INV-CC-REJECT-SIDEFX: a stale (launch-rejected) activity event produces no side effects", async () => {
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new DeterministicAgentOrchestrator(store);
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  orchestrator.setIO(makeFakeServerIO(emitted) as never);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  // Guard the agent on the current launch.
  (orchestrator as any).setLaunchGuard("agent-1", "launch-current");

  // A late event from a SUPERSEDED launch arrives → must be rejected.
  await orchestrator.handleMachineMessage("machine-1", {
    type: "agent:activity",
    agentId: "agent-1",
    activity: "working",
    detail: "from-stale-launch",
    launchId: "launch-OLD",
    clientSeq: 1,
  } as MachineToServerMessage);

  // No side effects: no local cache write, no Redis write-through, no emit.
  assert.equal((orchestrator as any).agentActivity.get("agent-1"), undefined,
    "rejected event must not write the local cache");
  assert.equal(await store.getAgentActivity("agent-1"), null,
    "rejected event must not write-through to Redis");
  assert.equal(emitted.filter((e) => e.event === "agent:activity").length, 0,
    "rejected event must not emit a realtime push");

  orchestrator.shutdown();
});

// ===========================================================================
// Cache-Coherence INV-CC-CONVERGE — realtime push is best-effort (CC-006).
// The `agent:activity` push may be dropped / delayed / reordered and MUST NOT be
// load-bearing for correctness: convergence is owed to the owner's synchronous
// write-through + the consumer's pull. These tests inject those faults at the
// `server.agentActivity.emit` failpoint seam and assert the authoritative pull
// still converges to the owner's committed value. Entries are attached so the
// broadcast takes the persist-and-emit-now path (immediate emit), exercising the
// seam deterministically rather than via the status-only debounce.
// ===========================================================================

function ccStatusEntry(activity: string, detail: string): TrajectoryEntry {
  return { kind: "status", activity: activity as AgentActivity, detail };
}

test("Cache-Coherence INV-CC-CONVERGE: a DROPPED realtime push still converges via pull (write-through is independent of the push)", async () => {
  const registry = new InMemoryFailpointRegistry();
  registry.configure("server.agentActivity.emit", { effect: "drop", mode: "always" });
  __setFailpointsForTests(registry);

  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  const owner = new DeterministicAgentOrchestrator(store);
  const pushed: Array<{ room: string; event: string; payload: unknown }> = [];
  owner.setIO(makeFakeServerIO(pushed) as never);
  seedActiveAgent(owner, "agent-1", "machine-1");
  seedMachineConnection(owner, "machine-1", makeFakeWs());

  try {
    await owner.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      activity: "working",
      detail: "committed",
      entries: [ccStatusEntry("working", "committed")],
      clientSeq: 1,
    } as MachineToServerMessage);
    await flushMicrotasks();

    // The push was attempted at the seam and dropped → no realtime emit observed.
    assert.ok(registry.getTrace().some((e) => e.key === "server.agentActivity.emit"),
      "emit seam must be exercised");
    assert.equal(pushed.filter((p) => p.event === "agent:activity").length, 0,
      "dropped push produces no realtime emit");

    // ...yet the write-through to Redis happened regardless of the dropped push.
    // TEETH: if write-through depended on the push, this would be null.
    assert.equal((await store.getAgentActivity("agent-1"))?.activity, "working",
      "write-through is independent of the (dropped) push");
    // ...and both an owner read and a non-owner pull converge to the committed value.
    assert.equal((await owner.getActivity("agent-1")).activity, "working");
    const nonOwner = new DeterministicAgentOrchestrator(store);
    seedActiveAgent(nonOwner, "agent-1", "machine-1");
    assert.equal((await nonOwner.getActivity("agent-1")).activity, "working",
      "a consumer that lost the push converges via pull");
    nonOwner.shutdown();
  } finally {
    __resetFailpointsForTests();
    owner.shutdown();
  }
});

test("Cache-Coherence INV-CC-CONVERGE: a DELAYED (in-flight) push does not gate convergence — pull converges before the push lands", async () => {
  let releaseEmit: () => void = () => {};
  const emitGate = new Promise<void>((res) => { releaseEmit = res; });
  const registry = new InMemoryFailpointRegistry({ sleep: () => emitGate });
  registry.configure("server.agentActivity.emit", { effect: "delay", payload: 1, mode: "always" });
  __setFailpointsForTests(registry);

  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  const owner = new DeterministicAgentOrchestrator(store);
  const pushed: Array<{ room: string; event: string; payload: unknown }> = [];
  owner.setIO(makeFakeServerIO(pushed) as never);
  seedActiveAgent(owner, "agent-1", "machine-1");
  seedMachineConnection(owner, "machine-1", makeFakeWs());

  try {
    await owner.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      activity: "working",
      detail: "committed",
      entries: [ccStatusEntry("working", "committed")],
      clientSeq: 1,
    } as MachineToServerMessage);
    await flushMicrotasks();

    // The push is still in-flight (gate held) → not yet delivered...
    assert.equal(pushed.filter((p) => p.event === "agent:activity").length, 0,
      "delayed push has not landed yet");
    // ...but the pull already converges (it does not wait for the push).
    assert.equal((await owner.getActivity("agent-1")).activity, "working",
      "pull converges while the push is still in-flight");
    assert.equal((await store.getAgentActivity("agent-1"))?.activity, "working");

    // Releasing the delayed push lands it; state remains converged.
    releaseEmit();
    await flushMicrotasks();
    assert.equal(pushed.filter((p) => p.event === "agent:activity").length, 1,
      "released push lands exactly once");
    assert.equal((await owner.getActivity("agent-1")).activity, "working");
  } finally {
    __resetFailpointsForTests();
    owner.shutdown();
  }
});

test("Cache-Coherence INV-CC-CONVERGE: a dropped intermediate push (reordered/lost) still converges to the latest committed value", async () => {
  const registry = new InMemoryFailpointRegistry();
  // Drop only the FIRST emit; let the second through.
  registry.configure("server.agentActivity.emit", { effect: "drop", mode: "once" });
  __setFailpointsForTests(registry);

  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1");
  const owner = new DeterministicAgentOrchestrator(store);
  const pushed: Array<{ room: string; event: string; payload: unknown }> = [];
  owner.setIO(makeFakeServerIO(pushed) as never);
  seedActiveAgent(owner, "agent-1", "machine-1");
  seedMachineConnection(owner, "machine-1", makeFakeWs());

  try {
    // First transition's push is dropped (mode: once).
    await owner.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      activity: "working",
      detail: "first",
      entries: [ccStatusEntry("working", "first")],
      clientSeq: 1,
    } as MachineToServerMessage);
    // Second transition's push lands.
    await owner.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      activity: "thinking",
      detail: "latest",
      entries: [ccStatusEntry("thinking", "latest")],
      clientSeq: 2,
    } as MachineToServerMessage);
    await flushMicrotasks();

    // Only the second push was observed (first dropped)...
    const activityPushes = pushed.filter((p) => p.event === "agent:activity");
    assert.equal(activityPushes.length, 1, "intermediate push dropped, latest delivered");
    // ...and the authoritative pull converges to the LATEST committed value.
    assert.equal((await store.getAgentActivity("agent-1"))?.activity, "thinking");
    assert.equal((await owner.getActivity("agent-1")).activity, "thinking",
      "convergence reflects the latest write-through regardless of dropped intermediate pushes");
    const nonOwner = new DeterministicAgentOrchestrator(store);
    seedActiveAgent(nonOwner, "agent-1", "machine-1");
    assert.equal((await nonOwner.getActivity("agent-1")).activity, "thinking");
    nonOwner.shutdown();
  } finally {
    __resetFailpointsForTests();
    owner.shutdown();
  }
});

// ===========================================================================
// Cache-Coherence regression anchor — full cross-replica restart lifecycle.
// One scenario chaining the whole class as an integration smoke: a regression
// in the cross-replica status / convergence path turns this red. It exercises:
//   - #2596/CC-003 — owner mapping committed before online emit (cross-replica
//     status reads online after connect/reconnect);
//   - #2601 / INV-CC-CONVERGE — the non-owner read-through-Redis CONVERGENCE
//     face (replica B has an empty local cache, so it pulls the shared store);
//   - #2607/RS-012 — reused launchId + monotonic dedup clock → post-restart
//     activity resumes, not dropped.
// Scope note (per Adspectum review): this anchor covers the cross-replica
// read/convergence face. It does NOT specifically exercise #2605's de-shadow
// *shadow-preference* (replica B is never seeded with a stale local shadow);
// that teeth lives in the INV-CC-FRESH conformance test (A, #2612) and #2605's
// own test. This is an integration smoke complementing those per-invariant teeth.
// Two real orchestrators (replica A owns the live connection, replica B reads
// cross-replica) over a shared replica-state store.
// ===========================================================================

test("Cache-Coherence regression anchor: full cross-replica restart lifecycle (connect → activity → restart → resume) converges end-to-end", async () => {
  const shared = new ControlledReplicaState();
  const clock = new FakeClock();
  const replicaA = new DeterministicAgentOrchestrator(new ControlledReplicaStateStore(shared, "replica-a"), clock);
  const replicaB = new DeterministicAgentOrchestrator(new ControlledReplicaStateStore(shared, "replica-b"), clock);
  // Both replicas know the agent (assigned to machine-1; owned by whichever
  // replica holds the live machine connection at the time).
  seedActiveAgent(replicaA, "agent-1", "machine-1");
  seedActiveAgent(replicaB, "agent-1", "machine-1");

  try {
    // --- Phase 1: connect on replica A. Owner mapping is committed BEFORE the
    // online status is observable (#2596/CC-003), so the cross-replica read on B
    // resolves online. ---
    const ws1 = makeFakeWs();
    await replicaA.registerMachine("machine-1", "server-1", ws1 as never);
    await flushMicrotasks();
    assert.equal(await replicaB.getMachineStatus("machine-1"), "online",
      "phase 1: cross-replica machine status is online after connect");

    // --- Phase 2: activity flows. Owner write-through to the shared store; the
    // non-owner pull converges via read-through (#2601 / INV-CC-CONVERGE). ---
    await replicaA.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      activity: "working",
      detail: "phase2",
      entries: [{ kind: "status", activity: "working" as AgentActivity, detail: "phase2" }],
      launchId: "launch-1",
      clientSeq: 5,
    } as MachineToServerMessage);
    await flushMicrotasks();
    assert.equal((await replicaA.getActivity("agent-1")).activity, "working",
      "phase 2: owner local read is working");
    assert.equal((await replicaB.getActivity("agent-1")).activity, "working",
      "phase 2: non-owner pull converges to working");

    // --- Phase 3: restart. Machine disconnects (offline), then reconnects
    // (online again, owner committed before emit). ---
    await replicaA.handleMachineDisconnect("machine-1", ws1 as never, { cause: "socket_close" });
    await advanceClockAndWaitForCondition(clock, 2000, () => !shared.machineOwners.has("machine-1"));
    assert.equal(await replicaB.getMachineStatus("machine-1"), "offline",
      "phase 3: cross-replica machine status is offline during the restart gap");

    const ws2 = makeFakeWs();
    await replicaA.registerMachine("machine-1", "server-1", ws2 as never);
    await flushMicrotasks();
    assert.equal(await replicaB.getMachineStatus("machine-1"), "online",
      "phase 3: cross-replica machine status is online again after reconnect");

    // --- Phase 4: activity resumes. The reconnect re-materialises the SAME
    // un-superseded launch, so launchId is reused and the dedup clock CONTINUES
    // (clientSeq 6 > 5, not reset to 1). The event is accepted, not dropped
    // (#2607/RS-012), and converges cross-replica. ---
    await replicaA.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      activity: "thinking",
      detail: "phase4-resumed",
      entries: [{ kind: "status", activity: "thinking" as AgentActivity, detail: "phase4-resumed" }],
      launchId: "launch-1",
      clientSeq: 6,
    } as MachineToServerMessage);
    await flushMicrotasks();
    assert.equal((await replicaA.getActivity("agent-1")).activity, "thinking",
      "phase 4: post-restart activity resumes for the owner (dedup clock stayed monotonic)");
    assert.equal((await replicaB.getActivity("agent-1")).activity, "thinking",
      "phase 4: post-restart activity converges cross-replica");
  } finally {
    replicaA.shutdown();
    replicaB.shutdown();
  }
});

function queuedUpgradePolicyDecision(
  overrides: Partial<ComputerBroadcastPolicyDecision> = {},
): ComputerBroadcastPolicyDecision {
  return {
    eligibility: "eligible",
    reasonCode: "eligible",
    policyRevision: "policy-v1",
    sourceVersion: "1.0.4",
    sourceObservedAt: "2026-07-24T04:59:00.000Z",
    sourceProvenance: "owner_connection",
    platform: { os: "linux", architecture: "x64" },
    targetVersion: "2.0.0",
    targetRole: "K",
    migrationClass: "controlled_reinstall_repair",
    policyRow: null,
    handsRelease: {
      releaseId: "release-1", buildId: "build-1", channel: "alpha", version: "2.0.0",
      sha256: "a".repeat(64), size: 100, url: "https://hands.build/artifact",
    },
    ...overrides,
  };
}

class QueuedUpgradePolicyOrchestrator extends DeterministicAgentOrchestrator {
  readonly evaluations: EvaluateComputerBroadcastPolicyInput[] = [];
  readonly relays: Array<{ machineId: string; action: string; operationId: string }> = [];
  readonly terminalizations: Array<{ operationId: string; reason: string }> = [];
  readonly markedSent: string[] = [];
  readonly releasedLeases: string[] = [];
  private claimReturned = false;

  constructor(
    private readonly claim: ClaimedComputerLifecycleDispatch,
    private readonly currentSource: ComputerSourceFact,
    private readonly currentDecision: ComputerBroadcastPolicyDecision,
  ) {
    const clock = new FakeClock();
    clock.advance(Date.parse("2026-07-24T05:00:00.000Z"));
    super(new InMemoryReplicaStateStore(), clock);
  }

  protected override async claimPendingComputerLifecycleDispatches(): Promise<ClaimedComputerLifecycleDispatch[]> {
    if (this.claimReturned) return [];
    this.claimReturned = true;
    return [this.claim];
  }

  protected override async loadComputerBroadcastMachine(): Promise<{ os: string | null }> {
    return { os: "linux x64" };
  }

  override async getMachineComputerVersionFact(): Promise<ComputerSourceFact> {
    return this.currentSource;
  }

  protected override async evaluateComputerBroadcastPolicy(
    input: EvaluateComputerBroadcastPolicyInput,
  ): Promise<ComputerBroadcastPolicyDecision> {
    this.evaluations.push(input);
    return this.currentDecision;
  }

  override async sendComputerControl(machineId: string, action: "restart" | "upgrade", operationId: string) {
    this.relays.push({ machineId, action, operationId });
    return { sent: true, requestId: operationId };
  }

  protected override async terminalizeComputerLifecycleOperation(input: {
    operationId: string;
    serverId: string;
    machineId: string;
    terminal: "failed" | "rolled_back" | "superseded";
    reason: string;
  }) {
    this.terminalizations.push({ operationId: input.operationId, reason: input.reason });
    return {
      status: "terminal" as const,
      fact: {
        operationId: input.operationId,
        serverId: input.serverId,
        machineId: input.machineId,
        action: "upgrade" as const,
        actorUserId: null,
        terminal: input.terminal,
        terminalReason: input.reason,
      },
      projections: [],
    };
  }

  protected override async releaseComputerLifecycleDispatchLease(operationId: string): Promise<void> {
    this.releasedLeases.push(operationId);
  }

  protected override async markComputerLifecycleCommandSent(operationId: string): Promise<boolean> {
    this.markedSent.push(operationId);
    return true;
  }

  async runQueuedDispatch(): Promise<void> {
    await this.dispatchPendingComputerLifecycleOperations();
  }
}

function queuedUpgradeClaim(
  persistedDecision: ComputerBroadcastPolicyDecision,
): ClaimedComputerLifecycleDispatch {
  return {
    operationId: "11111111-1111-4111-8111-111111111111",
    parentOperationId: "44444444-4444-4444-8444-444444444444",
    serverId: "22222222-2222-4222-8222-222222222222",
    machineId: "33333333-3333-4333-8333-333333333333",
    action: "upgrade",
    targetVersion: "2.0.0",
    broadcastPolicyDecision: JSON.parse(JSON.stringify(persistedDecision)) as Record<string, unknown>,
  };
}

test("queued upgrade retries a temporary Hands outage without sending or terminalizing", async () => {
  const admitted = queuedUpgradePolicyDecision();
  const claim = queuedUpgradeClaim(admitted);
  const orchestrator = new QueuedUpgradePolicyOrchestrator(claim, {
    version: "1.0.4", observedAt: null, provenance: "owner_connection",
  }, queuedUpgradePolicyDecision({ eligibility: "no_broadcast", reasonCode: "hands_unavailable" }));
  await orchestrator.runQueuedDispatch();
  assert.deepEqual(orchestrator.relays, []);
  assert.deepEqual(orchestrator.terminalizations, []);
  assert.deepEqual(orchestrator.releasedLeases, [claim.operationId]);
  orchestrator.shutdown();
});

test("queued upgrade re-dispatch terminally refuses a changed source with zero relay", async () => {
  const admitted = queuedUpgradePolicyDecision();
  const currentSource: ComputerSourceFact = {
    version: "1.0.5",
    observedAt: "2026-07-24T04:59:30.000Z",
    provenance: "owner_connection",
  };
  const orchestrator = new QueuedUpgradePolicyOrchestrator(
    queuedUpgradeClaim(admitted),
    currentSource,
    queuedUpgradePolicyDecision({
      eligibility: "no_broadcast",
      reasonCode: "policy_row_missing",
      sourceVersion: "1.0.5",
      targetVersion: null,
      targetRole: null,
      migrationClass: null,
      policyRow: null,
    }),
  );
  await orchestrator.runQueuedDispatch();
  assert.deepEqual(orchestrator.evaluations.map((input) => ({
    source: input.source,
    requestedTargetVersion: input.requestedTargetVersion,
  })), [{ source: currentSource, requestedTargetVersion: "2.0.0" }]);
  assert.deepEqual(orchestrator.relays, []);
  assert.deepEqual(orchestrator.markedSent, []);
  assert.deepEqual(orchestrator.terminalizations, [{
    operationId: "11111111-1111-4111-8111-111111111111",
    reason: "computer_broadcast_revalidation_policy_row_missing",
  }]);
  orchestrator.shutdown();
});

test("queued upgrade re-dispatch terminally refuses a withdrawn policy with zero relay", async () => {
  const admitted = queuedUpgradePolicyDecision();
  const orchestrator = new QueuedUpgradePolicyOrchestrator(
    queuedUpgradeClaim(admitted),
    {
      version: "1.0.4",
      observedAt: "2026-07-24T04:59:30.000Z",
      provenance: "owner_connection",
    },
    queuedUpgradePolicyDecision({
      eligibility: "no_broadcast",
      reasonCode: "policy_expired",
      targetVersion: null,
      targetRole: null,
      migrationClass: null,
      policyRow: null,
    }),
  );
  await orchestrator.runQueuedDispatch();
  assert.deepEqual(orchestrator.relays, []);
  assert.deepEqual(orchestrator.markedSent, []);
  assert.deepEqual(orchestrator.terminalizations.map((result) => result.reason), [
    "computer_broadcast_revalidation_policy_expired",
  ]);
  orchestrator.shutdown();
});

test("queued upgrade re-dispatch relays only when the full tuple remains eligible", async () => {
  const admitted = queuedUpgradePolicyDecision();
  const orchestrator = new QueuedUpgradePolicyOrchestrator(
    queuedUpgradeClaim(admitted),
    {
      version: "1.0.4",
      observedAt: "2026-07-24T04:59:30.000Z",
      provenance: "replica_meta",
    },
    queuedUpgradePolicyDecision({
      sourceObservedAt: "2026-07-24T04:59:30.000Z",
      sourceProvenance: "replica_meta",
    }),
  );
  await orchestrator.runQueuedDispatch();
  assert.deepEqual(orchestrator.terminalizations, []);
  assert.deepEqual(orchestrator.relays, [{
    machineId: "33333333-3333-4333-8333-333333333333",
    action: "upgrade",
    operationId: "11111111-1111-4111-8111-111111111111",
  }]);
  assert.deepEqual(orchestrator.markedSent, ["11111111-1111-4111-8111-111111111111"]);
  orchestrator.shutdown();
});

test("MachineMeta INV-CC-OWNER: ready-msg writes computerVersion to in-memory map AND mirrors to Redis", async () => {
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new DeterministicAgentOrchestrator(store);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  // First register so the connection has a serverId for the ready handler.
  // (handleMachineMessage's ready path only runs when conn exists.)
  // Simulate the ready message — handler stores in-memory + mirrors to Redis.
  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    runtimes: ["claude"],
    runningAgents: [],
    daemonVersion: "0.55.5",
    computerVersion: "0.0.61",
    hostname: "test-host",
    os: "darwin arm64",
  } as MachineToServerMessage);
  await flushMicrotasks();
  // Owner's in-memory has it (fast path)
  assert.equal((orchestrator as any).machineConnections.get("machine-1").computerVersion, "0.0.61");
  // ...and Redis mirror has it (cross-replica path)
  const meta = await store.getMachineMeta("machine-1");
  assert.equal(meta?.computerVersion, "0.0.61", "ready handler must mirror computerVersion to the meta store");
  assert.equal(meta?.daemonVersion, "0.55.5");
  assert.equal(meta?.hostname, "test-host");
  assert.equal(meta?.os, "darwin arm64");

  orchestrator.shutdown();
});

test("ready persists the reported Computer version with the injected clock timestamp", async () => {
  const clock = new FakeClock();
  clock.advance(1_234);
  const orchestrator = new ComputerVersionCaptureOrchestrator(
    new InMemoryReplicaStateStore(),
    clock,
  );
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    runtimes: [],
    runningAgents: [],
    computerVersion: "1.0.4",
  } as MachineToServerMessage);

  assert.deepEqual(orchestrator.computerVersionReports, [{
    machineId: "machine-1",
    computerVersion: "1.0.4",
    reportedAt: new Date(1_234),
  }]);
  orchestrator.shutdown();
});

test("accepted lifecycle ready acknowledgements double-write the loaded Computer version", async () => {
  const clock = new FakeClock();
  clock.advance(2_345);
  const orchestrator = new ComputerVersionCaptureOrchestrator(
    new InMemoryReplicaStateStore(),
    clock,
  );
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    runtimes: [],
    runningAgents: [],
    lifecycleAcks: [{
      operationId: "operation-1",
      action: "upgrade",
      phase: "ready",
      loadedComputerVersion: "1.0.5",
    }],
  } as MachineToServerMessage);

  assert.deepEqual(orchestrator.computerVersionReports, [{
    machineId: "machine-1",
    computerVersion: "1.0.5",
    reportedAt: new Date(2_345),
  }]);
  orchestrator.shutdown();
});

test("legacy upgrade completion frames double-write their loaded Computer version", async () => {
  const clock = new FakeClock();
  clock.advance(4_321);
  const orchestrator = new ComputerVersionCaptureOrchestrator(
    new InMemoryReplicaStateStore(),
    clock,
  );
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "computer:upgrade:done",
    requestId: "upgrade-1",
    ok: true,
    newVersion: "1.0.5",
  } as MachineToServerMessage);

  assert.deepEqual(orchestrator.computerVersionReports, [{
    machineId: "machine-1",
    computerVersion: "1.0.5",
    reportedAt: new Date(4_321),
  }]);
  orchestrator.shutdown();
});

test("ready reconciliation captures migration transport state in-memory and mirrors it to machine meta", async () => {
  const store = new InMemoryReplicaStateStore();
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(store, clock);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    runtimes: ["claude"],
    runningAgents: [],
    daemonVersion: "0.72.4",
    migrationTransport: {
      provisioned: true,
      endpoint: "https://migration-source.example.test",
      leaseSource: "env",
      protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
      capabilities: [...AGENT_MIGRATION_RESUMABLE_CAPABILITIES],
      observedAt: "2026-07-09T14:00:00.000Z",
    },
  } as MachineToServerMessage);
  await flushMicrotasks();

  const capturedAt = new Date(0).toISOString();
  assert.deepEqual(await orchestrator.getMachineMigrationTransport("machine-1"), {
    provisioned: true,
    endpoint: "https://migration-source.example.test",
    leaseSource: "env",
    protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
    capabilities: [...AGENT_MIGRATION_RESUMABLE_CAPABILITIES].sort(),
    observedAt: "2026-07-09T14:00:00.000Z",
    capturedAt,
  });
  const meta = await store.getMachineMeta("machine-1");
  assert.equal(meta?.migrationTransportProvisioned, "1");
  assert.equal(meta?.migrationTransportEndpoint, "https://migration-source.example.test");
  assert.equal(meta?.migrationTransportLeaseSource, "env");
  assert.equal(meta?.migrationTransportProtocol, AGENT_MIGRATION_RESUMABLE_PROTOCOL);
  assert.equal(meta?.migrationTransportCapabilities, JSON.stringify([...AGENT_MIGRATION_RESUMABLE_CAPABILITIES].sort()));
  assert.equal(meta?.migrationTransportObservedAt, "2026-07-09T14:00:00.000Z");
  assert.equal(meta?.migrationTransportCapturedAt, capturedAt);

  orchestrator.shutdown();
});

test("migration transport accessor falls back to the machine meta mirror on non-owner replicas", async () => {
  const store = new InMemoryReplicaStateStore();
  const replicaB = new DeterministicAgentOrchestrator(store);
  await store.setMachineMeta("machine-1", {
    migrationTransportProvisioned: "1",
    migrationTransportEndpoint: "https://migration-source.example.test",
    migrationTransportLeaseSource: "server",
    migrationTransportProtocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
    migrationTransportCapabilities: JSON.stringify([...AGENT_MIGRATION_RESUMABLE_CAPABILITIES]),
    migrationTransportObservedAt: "2026-07-09T14:00:00.000Z",
    migrationTransportCapturedAt: "2026-07-09T14:00:01.000Z",
  });

  assert.deepEqual(await replicaB.getMachineMigrationTransport("machine-1"), {
    provisioned: true,
    endpoint: "https://migration-source.example.test",
    leaseSource: "server",
    protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
    capabilities: [...AGENT_MIGRATION_RESUMABLE_CAPABILITIES].sort(),
    observedAt: "2026-07-09T14:00:00.000Z",
    capturedAt: "2026-07-09T14:00:01.000Z",
  });

  replicaB.shutdown();
});

test("missing migration transport ready field fails closed as not provisioned", async () => {
  const store = new InMemoryReplicaStateStore();
  const orchestrator = new DeterministicAgentOrchestrator(store);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    runtimes: ["claude"],
    runningAgents: [],
    daemonVersion: "0.72.3",
  } as MachineToServerMessage);
  await flushMicrotasks();

  assert.equal(await orchestrator.getMachineMigrationTransport("machine-1"), null);

  orchestrator.shutdown();
});

test("migration transport usable predicate requires server lease, non-loopback endpoint, and fresh server capture", () => {
  const nowMs = Date.parse("2026-07-09T14:02:00.000Z");
  const base = {
    provisioned: true,
    endpoint: "https://migration-source.example.test",
    leaseSource: "server" as const,
    observedAt: "2026-07-09T14:00:00.000Z",
    capturedAt: "2026-07-09T14:01:00.000Z",
  };

  assert.equal(isUsableMachineMigrationTransport(base, { nowMs }), true);
  assert.equal(isUsableMachineMigrationTransport({ ...base, leaseSource: "env" }, { nowMs }), false);
  assert.equal(isUsableMachineMigrationTransport({ ...base, endpoint: "http://localhost:4101" }, { nowMs }), false);
  assert.equal(isUsableMachineMigrationTransport({ ...base, endpoint: "http://127.0.0.1:4101" }, { nowMs }), false);
  assert.equal(isUsableMachineMigrationTransport({ ...base, endpoint: "http://0.0.0.0:4101" }, { nowMs }), false);
  assert.equal(isUsableMachineMigrationTransport({ ...base, endpoint: "http://[::1]:4101" }, { nowMs }), false);
  assert.equal(isUsableMachineMigrationTransport({ ...base, capturedAt: "2026-07-09T13:59:00.000Z" }, { nowMs }), false);
  assert.equal(isUsableMachineMigrationTransport({ ...base, capturedAt: "2026-07-09T14:03:00.000Z" }, { nowMs }), false);
  assert.equal(isUsableMachineMigrationTransport({ ...base, capturedAt: "not-a-date" }, { nowMs }), false);
  assert.equal(isUsableMachineMigrationTransport(null, { nowMs }), false);
});

test("MachineMeta INV-CC-FRESH: non-owner read pulls computerVersion from the Redis mirror, not its own empty map", async () => {
  const store = new InMemoryReplicaStateStore();
  const replicaB = new DeterministicAgentOrchestrator(store);
  // Owner replica wrote the meta — simulate that here by populating the
  // shared store directly. replicaB has no machineConnections entry.
  await store.setMachineMeta("machine-1", {
    computerVersion: "0.0.61",
    computerVersionObservedAt: "2026-07-24T05:00:00.000Z",
    daemonVersion: "0.55.5",
  });

  const version = await replicaB.getMachineComputerVersion("machine-1");
  assert.equal(version, "0.0.61",
    "non-owner replica must fall back to the meta mirror when local map is empty");
  assert.deepEqual(await replicaB.getMachineComputerVersionFact("machine-1"), {
    version: "0.0.61",
    observedAt: "2026-07-24T05:00:00.000Z",
    provenance: "replica_meta",
  });

  replicaB.shutdown();
});

test("MachineMeta INV-CC-FRESH (degraded): non-owner with Redis unavailable returns null instead of falling through to a stale value", async () => {
  const store = new RedisUnavailableReplicaStateStore();
  // Even though the InMemory backing has data, isAvailable() returns false →
  // getMachineComputerVersion must not consult it.
  await (store as any).setMachineMeta?.("machine-1", { computerVersion: "0.0.61" });
  const replicaB = new DeterministicAgentOrchestrator(store);

  const version = await replicaB.getMachineComputerVersion("machine-1");
  assert.equal(version, null,
    "Redis-down non-owner returns null; never fabricates a value from somewhere it isn't authorised to read");
  assert.equal(await replicaB.getMachineComputerVersionFact("machine-1"), null);

  replicaB.shutdown();
});

test("MachineMeta on disconnect clears the meta mirror so non-owner replicas don't return a stale computerVersion", async () => {
  const store = new InMemoryReplicaStateStore();
  const clock = new IncrementingNowClock();
  const orchestrator = new DeterministicAgentOrchestrator(store, clock);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    runtimes: [],
    runningAgents: [],
    daemonVersion: "0.55.5",
    computerVersion: "0.0.61",
  } as MachineToServerMessage);
  await flushMicrotasks();
  assert.equal((await store.getMachineMeta("machine-1"))?.computerVersion, "0.0.61");
  assert.equal(typeof (await store.getMachineMeta("machine-1"))?.computerVersionObservedAt, "string");
  assert.deepEqual(await orchestrator.getMachineComputerVersionFact("machine-1"), {
    version: "0.0.61",
    observedAt: (await store.getMachineMeta("machine-1"))?.computerVersionObservedAt,
    provenance: "owner_connection",
  });

  // Drop the connection (clearMachineConnection is the private cleanup
  // path called by handleMachineDisconnect; we invoke it directly here to
  // pin the meta-clear contract without spinning up a fake socket close).
  await (orchestrator as any).clearMachineConnection("machine-1", true);
  await flushMicrotasks();

  assert.equal(await store.getMachineMeta("machine-1"), null,
    "disconnect must clear the meta mirror; otherwise a non-owner replica would keep serving the stale version");

  orchestrator.shutdown();
});

test("MachineMeta heartbeat gives owner and replica reads the same Computer-version observation timestamp", async () => {
  const store = new InMemoryReplicaStateStore();
  const clock = new IncrementingNowClock();
  const orchestrator = new DeterministicAgentOrchestrator(store, clock);
  const conn = seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    runtimes: [],
    runningAgents: [],
    daemonVersion: "0.55.5",
    computerVersion: "0.0.61",
  } as MachineToServerMessage);
  await flushMicrotasks();

  await orchestrator.handleMachineMessage("machine-1", { type: "pong" } as MachineToServerMessage);
  await flushMicrotasks();

  const meta = await store.getMachineMeta("machine-1");
  assert.equal(conn.lastPong, conn.lastIngressAt,
    "one pong frame must give both owner liveness projections the same observation time");
  assert.equal(new Date(conn.lastPong).toISOString(), meta?.computerVersionObservedAt,
    "the owner heartbeat and replica mirror must project the same pong observation time");
  assert.deepEqual(await orchestrator.getMachineComputerVersionFact("machine-1"), {
    version: "0.0.61",
    observedAt: meta?.computerVersionObservedAt,
    provenance: "owner_connection",
  });

  orchestrator.shutdown();
});

test("MachineMeta TTL FUSE (alive): heartbeat refreshes the meta TTL — non-owner read still resolves past the original TTL on a long-lived connection", async () => {
  const store = new InMemoryReplicaStateStore();
  // Use a small TTL so the test doesn't have to advance an absurd clock.
  // The clock is also driven manually so we can step over the boundary.
  let nowMs = 0;
  store.setMachineMetaClock(() => nowMs, 60); // 60s TTL
  const orchestrator = new DeterministicAgentOrchestrator(store);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    runtimes: [],
    runningAgents: [],
    daemonVersion: "0.55.5",
    computerVersion: "0.0.61",
  } as MachineToServerMessage);
  await flushMicrotasks();

  // Advance past the original TTL, but heartbeat (pong) midway through to
  // refresh it. The heartbeat case in handleMachineMessage upserts via
  // `setMachineMeta` from the conn's live fields, which both rewrites the
  // hash and resets the deadline to nowMs + ttl.
  nowMs = 30_000;
  await orchestrator.handleMachineMessage("machine-1", { type: "pong" } as MachineToServerMessage);
  await flushMicrotasks();
  // Read at 89s — past the ORIGINAL 60s TTL, but the heartbeat at 30s reset
  // the deadline to 90s. If meta refresh is wired correctly the read still
  // resolves; if not the original TTL would have already expired the entry.
  nowMs = 89_000;
  // Drop the in-memory fast path so the read is forced to consult the
  // Redis mirror (the real cross-replica scenario this is regressing).
  (orchestrator as any).machineConnections.delete("machine-1");
  const version = await orchestrator.getMachineComputerVersion("machine-1");
  assert.equal(version, "0.0.61",
    "alive connection: heartbeat refresh keeps meta available past the original TTL");

  orchestrator.shutdown();
});

test("MachineMeta TTL FUSE (dead): owner stops heartbeating (crash) → meta DOES expire past TTL — fuse fires, no stale-forever", async () => {
  const store = new InMemoryReplicaStateStore();
  let nowMs = 0;
  store.setMachineMetaClock(() => nowMs, 60); // 60s TTL
  const orchestrator = new DeterministicAgentOrchestrator(store);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    runtimes: [],
    runningAgents: [],
    daemonVersion: "0.55.5",
    computerVersion: "0.0.61",
  } as MachineToServerMessage);
  await flushMicrotasks();

  // Owner crashes — no heartbeat. Advance past the TTL.
  nowMs = 60_001;
  // Force the orchestrator to read from the store path: drop the in-memory
  // entry so the fast path doesn't shadow the expired mirror. This models
  // "non-owner replica with no local conn entry, owner replica unreachable
  // and never refreshed the mirror in time".
  (orchestrator as any).machineConnections.delete("machine-1");
  const version = await orchestrator.getMachineComputerVersion("machine-1");
  assert.equal(version, null,
    "dead-owner fuse: meta expires past TTL when no heartbeat refreshes it; non-owner reads null, never a stale-forever value");

  orchestrator.shutdown();
});

test("MachineMeta SELF-HEAL: heartbeat upserts the meta even when the original ready-write missed Redis (or the entry was evicted)", async () => {
  const store = new InMemoryReplicaStateStore();
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(store, clock);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  await orchestrator.handleMachineMessage("machine-1", {
    type: "ready",
    runtimes: [],
    runningAgents: [],
    daemonVersion: "0.55.5",
    computerVersion: "0.0.61",
  } as MachineToServerMessage);
  await flushMicrotasks();
  // Simulate "Redis missed the ready write OR evicted the key" by deleting
  // the mirror directly. The owner's in-memory map still holds the value,
  // but a non-owner replica REST hit right now would return null.
  await store.clearMachineMeta("machine-1");
  assert.equal(await store.getMachineMeta("machine-1"), null,
    "precondition: meta is cleared so any cross-replica read would miss");

  // Heartbeat (pong) — the upsert path must repopulate fields from conn
  // state, not just no-op on a missing key.
  clock.advance(1_000);
  await orchestrator.handleMachineMessage("machine-1", { type: "pong" } as MachineToServerMessage);
  await flushMicrotasks();

  const meta = await store.getMachineMeta("machine-1");
  assert.equal(meta?.computerVersion, "0.0.61",
    "heartbeat must recreate meta from owner's live conn fields, not assume the entry already exists");
  assert.equal(meta?.daemonVersion, "0.55.5");
  assert.equal(meta?.computerVersionObservedAt, "1970-01-01T00:00:01.000Z",
    "heartbeat must refresh the source fact timestamp that non-owner policy evaluation consumes");

  orchestrator.shutdown();
});

// These assert the SWEEP DECISION synchronously by capturing broadcastActivity
// calls, not the async downstream cache write. The real broadcastActivity is
// async and its cache mutation is order/timing-sensitive across a shared shard
// process, so asserting `agentActivity` after a non-awaited sweep call is flaky
// under sharding (was #161 fix-forward). Spying the decision is deterministic.
function captureSweepBroadcasts(orchestrator: AgentOrchestrator): Array<{ activity: string; detail: string }> {
  const broadcasts: Array<{ activity: string; detail: string }> = [];
  (orchestrator as unknown as { broadcastActivity: unknown }).broadcastActivity =
    (_agentId: string, activity: string, detail: string) => {
      broadcasts.push({ activity, detail });
      return Promise.resolve();
    };
  return broadcasts;
}

test("stale sweep resolves a stuck working/'Starting…' via an online broadcast, not a preserve re-broadcast (#161)", () => {
  // Relaunch (Disconnected → Starting → new launch) whose ready path did not
  // fire maybeResolveStartingActivity leaves the transitional working/"Starting…"
  // visible. The probe-timeout / stale sweep must RESOLVE it (broadcast online),
  // not re-broadcast (pin) it — else the activity bar/status-history freezes on
  // "Starting" while the agent is live. (#161 starting-line consumer closure)
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), clock);
  seedActiveAgent(orchestrator);
  clock.advance(20_000);
  const broadcasts = captureSweepBroadcasts(orchestrator);
  (orchestrator as unknown as { agentActivity: Map<string, { activity: string; detail: string; detailKind: string; updatedAt: number }> })
    .agentActivity.set("agent-1", { activity: "working", detail: "Starting…", detailKind: "starting", updatedAt: clock.now() });

  (orchestrator as unknown as { refreshStaleTransientActivity(agentId: string, now: number): void })
    .refreshStaleTransientActivity("agent-1", clock.now());

  assert.ok(
    broadcasts.some((b) => b.activity === "online"),
    "stuck 'Starting…' must be routed to a resolve→online broadcast",
  );
  assert.ok(
    !broadcasts.some((b) => b.activity === "working" && b.detail === "Starting…"),
    "stuck 'Starting…' must NOT be re-broadcast/preserved by the sweep",
  );
  orchestrator.shutdown();
});

test("stale sweep preserves genuine busy state without a synthetic re-broadcast (#161, task #499)", () => {
  const clock = new FakeClock();
  const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), clock);
  seedActiveAgent(orchestrator);
  clock.advance(20_000);
  const broadcasts = captureSweepBroadcasts(orchestrator);
  (orchestrator as unknown as { agentActivity: Map<string, { activity: string; detail: string; detailKind: string; updatedAt: number }> })
    .agentActivity.set("agent-1", { activity: "working", detail: "Running tests", detailKind: "running_command", updatedAt: clock.now() });

  (orchestrator as unknown as { refreshStaleTransientActivity(agentId: string, now: number): void })
    .refreshStaleTransientActivity("agent-1", clock.now());

  assert.deepEqual(broadcasts, [], "no-authority timeout preservation must not emit any user activity");
  assert.deepEqual(
    (orchestrator as unknown as {
      agentActivity: Map<string, { activity: string; detail: string; detailKind: string; updatedAt: number }>;
    }).agentActivity.get("agent-1"),
    { activity: "working", detail: "Running tests", detailKind: "running_command", updatedAt: clock.now() },
  );
  orchestrator.shutdown();
});

test("lifecycle-v2 shadow wiring: accepted ingest feeds probeId/entries/declared-bit into the observation classifier (task #460 witness b)", async () => {
  // Witness (b), authored by saber, executed/audited by Kai (author/oracle
  // split). Proves the accepted-activity ingest REALLY maps msg.probeId ->
  // incoming.probeId, msg.entries -> hasEntries, and msg.isHeartbeat ->
  // declaredHeartbeat before classification — a correct classifier behind an
  // unfed gate would silently misclassify (the "door with no wire" failure).
  // Truth surface: lifecycle_v2.shadow_verdict span events only.
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(10_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock, tracer);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const busy = { activity: "working", detail: "Running command…", detailKind: "running_command" } as const;
  const send = (overrides: Record<string, unknown>) =>
    orchestrator.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      ...busy,
      launchId: "L-1",
      ...overrides,
    } as MachineToServerMessage);

  // 1. Genuine broadcast with fresh entries establishes the busy snapshot.
  await send({ clientSeq: 1, entries: [{ kind: "thinking", text: "t" }], producerFactId: "daemon_activity:agent-1:L-1:1" });
  clock.advance(1_000);
  // 2. Probe echo: identical content, NO entries — the legacy content shim
  //    would misread it as replayed; the explicit probeId marker must win.
  await send({ clientSeq: 2, probeId: "P-1", producerFactId: "daemon_activity:agent-1:L-1:2" });
  clock.advance(1_000);
  // 3. Markerless twin of the probe echo (no probeId, no entries, same
  //    content) -> legacy shim classifies replayed. The (2)/(3) pair proves
  //    the probe rescue is targeted, not a blanket loosening.
  await send({ clientSeq: 3, producerFactId: "daemon_activity:agent-1:L-1:3" });
  clock.advance(1_000);
  // 4. Producer-declared heartbeat wins over changed content (bit is the
  //    canonical key, not content inference).
  await send({ clientSeq: 4, detail: "Editing file…", isHeartbeat: true, producerFactId: "daemon_activity:agent-1:L-1:4" });
  clock.advance(1_000);
  // 5. Declared false wins over identical content (closes the reverse pit:
  //    a genuine identical re-observation keeps liveness).
  await send({ clientSeq: 5, isHeartbeat: false, producerFactId: "daemon_activity:agent-1:L-1:5" });

  // Canonical capture: stored-const getAllSpans + flatMap (the exact shape
  // Kai's in-place probe verified reads all events). eventsForSpan is
  // find-first (single span) and each ingest creates its own span, so it
  // structurally under-reads multi-ingest tests; completed spans snapshot
  // their events (BasicTracer end(): events: [...this.events]).
  const allSpans = sink.getAllSpans();
  const allEvents = allSpans.flatMap((span) => span.events);
  const verdicts = allEvents
    .filter((event) => event.name === "lifecycle_v2.shadow_verdict")
    .map((event) => event.attrs ?? {});
  // Self-reporting oracle: if the 5-vs-1 paradox ever recurs, the failure
  // message carries the raw evidence instead of a bare count mismatch.
  assert.equal(
    verdicts.length,
    5,
    `shadow_verdict capture paradox: spans=${allSpans.length} events=${allEvents.length} names=${JSON.stringify(allEvents.map((event) => event.name))}`,
  );
  assert.equal(verdicts[0].shadow_observation_class, "activity_assertion", "send-1 genuine broadcast with entries");
  assert.equal(verdicts[0].event_kind, "activity_observed");
  assert.equal(verdicts[1].shadow_observation_class, "liveness_observation", "send-2 probe echo must be rescued by probeId, not content-shimmed");
  assert.equal(verdicts[1].event_kind, "activity_snapshot");
  assert.equal(verdicts[2].shadow_observation_class, "activity_replay", "send-3 markerless twin must fall to the content shim");
  assert.equal(verdicts[3].shadow_observation_class, "activity_replay", "send-4 declared heartbeat wins over changed content");
  assert.equal(verdicts[4].shadow_observation_class, "activity_assertion", "send-5 declared false wins over identical content");
  // The replayed verdict must preserve, never impersonate fresh observation.
  assert.equal(verdicts[2].shadow_action, "preserve");
  assert.equal(verdicts[2].shadow_reason, "replayed_no_authority");
  // Real entries still emit immediately. Probe snapshots and explicit
  // heartbeats each emit refresh-only socket frames, with distinct provenance
  // so clients update live state without appending timeline rows.
  assert.equal(
    (orchestrator as unknown as { emittedActivityPayloads: unknown[] }).emittedActivityPayloads.length,
    3,
    "send-1 emits durable entries; send-2 probe and send-4 heartbeat each emit one refresh-only frame",
  );
  assert.equal(orchestrator.emittedActivityPayloads[1]?.probeId, "P-1");
  assert.equal(orchestrator.emittedActivityPayloads[1]?.isRefreshOnly, true);
  assert.equal(orchestrator.emittedActivityPayloads[1]?.isHeartbeat, undefined);
  assert.equal(orchestrator.emittedActivityPayloads[2]?.isHeartbeat, true);
  assert.equal(orchestrator.emittedActivityPayloads[2]?.isRefreshOnly, true);
  assert.equal(orchestrator.emittedActivityPayloads[2]?.clientSeq, 4);

  orchestrator.shutdown();
});

test("daemon heartbeat refreshes message_received without duplicating durable or socket timeline history", async () => {
  const clock = new FakeClock();
  clock.advance(20_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const send = (clientSeq: number, isHeartbeat: boolean) =>
    orchestrator.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      activity: "working",
      activityKind: "working",
      detail: "Message received",
      detailKind: "message_received",
      launchId: "L-1",
      clientSeq,
      producerFactId: `daemon_activity:agent-1:L-1:${clientSeq}`,
      isHeartbeat,
    });

  await send(1, false);
  await Promise.resolve();
  clock.advance(60_000);
  await send(2, true);
  await Promise.resolve();

  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [{
    timestamp: 20_000,
    entry: {
      kind: "status",
      activity: "working",
      activityKind: "working",
      detail: "Message received",
      detailKind: "message_received",
    },
  }]);
  assert.equal(orchestrator.emittedActivityPayloads.length, 2);
  assert.equal(orchestrator.emittedActivityPayloads[0]?.isHeartbeat, undefined);
  assert.equal(orchestrator.emittedActivityPayloads[1]?.isHeartbeat, true);
  assert.equal(orchestrator.emittedActivityPayloads[1]?.isRefreshOnly, true);
  assert.equal(orchestrator.emittedActivityPayloads[1]?.timestamp, 80_000);
  assert.equal(orchestrator.emittedActivityPayloads[1]?.clientSeq, 2);

  orchestrator.shutdown();
});

test("activity probe refreshes message_received without duplicating durable or socket timeline history", async () => {
  const clock = new FakeClock();
  clock.advance(20_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const send = (clientSeq: number, probeId?: string) =>
    orchestrator.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      activity: "working",
      activityKind: "working",
      detail: "Message received",
      detailKind: "message_received",
      launchId: "L-1",
      clientSeq,
      producerFactId: `daemon_activity:agent-1:L-1:${clientSeq}`,
      isHeartbeat: false,
      ...(probeId ? { probeId } : {}),
    });

  await send(1);
  await Promise.resolve();
  clock.advance(20_000);
  await send(2, "probe-1");
  await Promise.resolve();

  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [{
    timestamp: 20_000,
    entry: {
      kind: "status",
      activity: "working",
      activityKind: "working",
      detail: "Message received",
      detailKind: "message_received",
    },
  }]);
  assert.equal(orchestrator.emittedActivityPayloads.length, 2);
  assert.equal(orchestrator.emittedActivityPayloads[0]?.isRefreshOnly, undefined);
  assert.equal(orchestrator.emittedActivityPayloads[1]?.probeId, "probe-1");
  assert.equal(orchestrator.emittedActivityPayloads[1]?.isHeartbeat, undefined);
  assert.equal(orchestrator.emittedActivityPayloads[1]?.isRefreshOnly, true);
  assert.equal(orchestrator.emittedActivityPayloads[1]?.timestamp, 40_000);
  assert.equal(orchestrator.emittedActivityPayloads[1]?.clientSeq, 2);

  orchestrator.shutdown();
});

test("heartbeat supersedes a pending non-durable debounce without losing the durable boundary", async () => {
  const clock = new FakeClock();
  clock.advance(10_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const broadcast = (
    detail: string,
    detailKind: AgentActivityDetailKind,
    isHeartbeat: boolean,
    clientSeq: number,
  ) => (orchestrator as any).broadcastActivity(
    "agent-1",
    "working",
    detail,
    detailKind,
    undefined,
    clock.now(),
    {
      launchId: "L-1",
      clientSeq,
      producerFactId: `daemon_activity:agent-1:L-1:${clientSeq}`,
      isHeartbeat,
      arbitration: {
        observationClass: isHeartbeat ? "replayed" : "observed",
        signalSite: "daemon_ingest",
      },
    },
  );

  // Durable status-only kinds never enter the debounce queue.
  broadcast("Message received", "message_received", false, 1);
  await Promise.resolve();
  assert.equal((orchestrator as any).activityDebounceTimers.has("agent-1"), false);

  // running_command is deliberately live-only. Its pending debounce owns no
  // durable row; a later heartbeat carries the same latest daemon snapshot.
  clock.advance(1_000);
  broadcast("Running command", "running_command", false, 2);
  assert.equal((orchestrator as any).activityDebounceTimers.has("agent-1"), true);
  clock.advance(60_000);
  broadcast("Running command", "running_command", true, 3);
  await Promise.resolve();

  assert.equal((orchestrator as any).activityDebounceTimers.has("agent-1"), false);
  assert.deepEqual(await orchestrator.listRecentActivityLog("agent-1"), [{
    timestamp: 10_000,
    entry: {
      kind: "status",
      activity: "working",
      activityKind: "working",
      detail: "Message received",
      detailKind: "message_received",
    },
  }]);
  assert.equal(orchestrator.emittedActivityPayloads.length, 2);
  assert.deepEqual(orchestrator.emittedActivityPayloads[1], {
    agentId: "agent-1",
    activity: "working",
    activityKind: "working",
    detail: "Running command",
    detailKind: "running_command",
    timestamp: 71_000,
    serverSeq: 2,
    launchId: "L-1",
    clientSeq: 3,
    producerFactId: "daemon_activity:agent-1:L-1:3",
    isHeartbeat: true,
    isRefreshOnly: true,
  });

  orchestrator.shutdown();
});

test("turn_active classifier: message_received is distinct from runtime observation but markerless heartbeat twins stay replayed", () => {
  const messageReceived = {
    activity: "working",
    detail: "Message received",
    detailKind: "message_received",
    hasEntries: false,
  } as const;
  assert.equal(
    classifyDaemonActivityObservation({ declaredHeartbeat: false, incoming: messageReceived }),
    "observed_turn_active",
  );
  assert.equal(
    classifyDaemonActivityObservation({
      declaredHeartbeat: null,
      incoming: messageReceived,
      lastAccepted: messageReceived,
    }),
    "replayed",
    "legacy markerless repeats of the same message_received snapshot are heartbeat replays, not new turn starts",
  );
  assert.equal(
    classifyDaemonActivityObservation({
      declaredHeartbeat: null,
      incoming: { ...messageReceived, probeId: "probe-1" },
      lastAccepted: messageReceived,
    }),
    "observed",
    "activity probes remain liveness observations, not turn-start observations",
  );
});

test("lifecycle-v2 shadow accounting: every divergence-drop species carries a computed shadow_observation_class (task #460 witness c)", async () => {
  // Witness (c), authored by saber, executed/audited by Kai. The three
  // divergence-drop species must each carry shadow_observation_class:
  // stale_client_seq is definitionally the wire-replay species (literal),
  // while the two generation-axis drops compute the class with the SAME
  // production classifier as the accept path — proven computed (not
  // hardcoded) by driving both replayed and observed outcomes through the
  // same drop reason. Truth surface: activity.ingest.dropped span events.
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(20_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock, tracer);
  seedActiveAgent(orchestrator);
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());

  const busy = { activity: "working", detail: "Running command…", detailKind: "running_command" } as const;
  const send = (overrides: Record<string, unknown>) =>
    orchestrator.handleMachineMessage("machine-1", {
      type: "agent:activity",
      agentId: "agent-1",
      ...busy,
      ...overrides,
    } as MachineToServerMessage);

  // Baseline accept: seeds the snapshot and the (launchId, clientSeq) cursor.
  await send({ launchId: "L-1", clientSeq: 10, entries: [{ kind: "thinking", text: "t" }] });
  clock.advance(1_000);
  // Species 1: duplicate clientSeq -> stale_client_seq (wire-level replay).
  await send({ launchId: "L-1", clientSeq: 10 });
  clock.advance(1_000);

  // Arm the launch guard so generation-axis drops fire.
  const cached = (orchestrator as unknown as { agentStateCache: Map<string, { launchGuardMode: string; expectedLaunchId: string | null }> })
    .agentStateCache.get("agent-1")!;
  cached.launchGuardMode = "guarded";
  cached.expectedLaunchId = "L-NEW";

  // Species 2a: stale generation + unchanged content + no entries -> the
  // classifier computes replayed.
  await send({ launchId: "L-OLD", clientSeq: 11 });
  clock.advance(1_000);
  // Species 2b: stale generation + changed content + fresh entries -> the
  // SAME drop reason now computes observed. 2a/2b together pin "computed by
  // the production classifier", not a hardcoded tag.
  await send({ launchId: "L-OLD", clientSeq: 12, detail: "Editing file…", entries: [{ kind: "thinking", text: "u" }] });
  clock.advance(1_000);
  // Species 2c: stale generation + message_received -> the same drop row
  // taxonomy must preserve turn-active authority instead of falling through
  // to synthetic_repair.
  await send({ launchId: "L-OLD", clientSeq: 13, detail: "Message received", detailKind: "message_received" });
  clock.advance(1_000);
  // Species 3: guarded agent, message without any launchId -> legacy
  // cohort drop, class computed (unchanged content, no entries -> replayed).
  await send({ clientSeq: 14 });

  // Same canonical stored-const capture as witness (b).
  const allSpansC = sink.getAllSpans();
  const drops = allSpansC
    .flatMap((span) => span.events)
    .filter((event) => event.name === "activity.ingest.dropped")
    .map((event) => event.attrs ?? {});
  const byReason = (reason: string) => drops.filter((attrs) => attrs.reason === reason);

  const staleSeq = byReason("stale_client_seq");
  assert.equal(staleSeq.length, 1);
  assert.equal(staleSeq[0].shadow_observation_class, "activity_replay");
  assert.equal(staleSeq[0].event_kind, "activity_replayed");

  const staleLaunch = byReason("stale_launch_guard");
  assert.equal(staleLaunch.length, 3);
  assert.equal(staleLaunch[0].shadow_observation_class, "activity_replay");
  assert.equal(staleLaunch[1].shadow_observation_class, "activity_assertion");
  assert.equal(staleLaunch[1].advances_observed_clock, "activity");
  assert.equal(staleLaunch[2].shadow_observation_class, "observed_turn_active");
  assert.equal(staleLaunch[2].event_kind, "turn_active");
  assert.equal(staleLaunch[2].source, "daemon_runtime");
  assert.equal(staleLaunch[2].authority, "observed_turn_active");
  assert.equal(staleLaunch[2].advances_observed_clock, "activity");

  const legacy = byReason("legacy_lifecycle_event");
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].shadow_observation_class, "activity_replay");

  orchestrator.shutdown();
});

test("lifecycle-v2 gamma shadow: busy-preserve emits a no-authority diagnostic without re-stamping freshness (task #499)", () => {
  // The scheduler-repair preserve carrier keeps the historical
  // preserve_rebroadcast taxonomy for trace continuity, but a timeout has no
  // authority to write the snapshot or advance freshness.
  const { sink, tracer } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(60_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock, tracer);
  seedActiveAgent(orchestrator);
  const staleAtMs = clock.now() - 30_000;
  (orchestrator as unknown as { agentActivity: Map<string, { activity: string; detail: string; detailKind: string; updatedAt: number }> })
    .agentActivity.set("agent-1", { activity: "working", detail: "Running tests", detailKind: "running_command", updatedAt: staleAtMs });

  (orchestrator as unknown as { refreshStaleTransientActivity(agentId: string, now: number): void })
    .refreshStaleTransientActivity("agent-1", clock.now());

  // Site-span binding: the verdict must ride ON the busy_preserved span, so
  // the ScopeDB readtable can join vector 3 without content guessing.
  const preserveSpans = sink.getAllSpans().filter((span) => span.name === "server.agent.stale_activity.busy_preserved");
  assert.equal(preserveSpans.length, 1, "exactly one busy_preserved span for one sweep leg");
  const verdicts = preserveSpans
    .flatMap((span) => span.events)
    .filter((event) => event.name === "lifecycle_v2.shadow_verdict")
    .map((event) => event.attrs ?? {});
  assert.equal(verdicts.length, 1, "busy-preserve leg must emit exactly one shadow verdict");
  const verdict = verdicts[0];
  assert.equal(verdict.shadow_signal_site, "preserve_rebroadcast", "three-vector bucketing key: stale-sweep preserve carrier");
  assert.equal(verdict.shadow_observation_class, "synthetic_diagnostic", "timeout preservation is not an observation");
  assert.equal(verdict.event_kind, "synthetic_repair");
  assert.equal(verdict.source, "scheduler_repair");
  assert.equal(verdict.authority, "scheduler_repair");
  assert.equal(verdict.shadow_action, "preserve");
  assert.equal(verdict.shadow_reason, "synthetic_no_authority");
  assert.equal(verdict.shadow_agree, true, "value axis agrees because the serving snapshot is preserved");
  assert.equal(verdict.shadow_direction, "lateral");
  assert.equal(verdict.shadow_projection, "working");
  assert.equal(verdict.shadow_prior_projection, "working");
  assert.equal(verdict.advances_observed_clock, "none");
  // Canonical half: no re-broadcast means the serving clock remains on the
  // original observation instead of being laundered to the sweep time.
  const after = (orchestrator as unknown as { agentActivity: Map<string, { updatedAt: number }> }).agentActivity.get("agent-1");
  assert.equal(after?.updatedAt, staleAtMs, "no-authority preservation must not re-stamp updatedAt");
  const [busyRow] = traceEventRowsForSpanName(sink, preserveSpans[0].context.traceId, "server.agent.stale_activity.busy_preserved")
    .filter((row) => row.event_name === "lifecycle_v2.shadow_verdict");
  assert.equal(busyRow.shadow_agent_id, "agent-1");
  assert.equal(busyRow.shadow_observation_class, "synthetic_diagnostic");
  assert.equal(busyRow.event_kind, "synthetic_repair");
  assert.equal(busyRow.source, "scheduler_repair");
  assert.equal(busyRow.authority, "scheduler_repair");
  assert.equal(busyRow.shadow_signal_site, "preserve_rebroadcast");

  orchestrator.shutdown();
});

test("agent activity kernel arbitration stays default-dark: stale observed arrival still follows legacy last-write-wins", () => {
  withAgentActivityKernelEnv({}, () => {
    const clock = new FakeClock();
    const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), clock);
    (orchestrator as any).broadcastActivity(
      "agent-1",
      "working",
      "newer observed work",
      "running_command",
      undefined,
      200,
      {
        observedAtMs: 200,
        arbitration: { observationClass: "observed", signalSite: "daemon_ingest" },
      },
    );
    (orchestrator as any).broadcastActivity(
      "agent-1",
      "online",
      "older observed online",
      "none",
      undefined,
      300,
      {
        observedAtMs: 100,
        arbitration: { observationClass: "observed", signalSite: "daemon_ingest" },
      },
    );

    const snapshot = (orchestrator as any).agentActivity.get("agent-1");
    assert.equal(snapshot.activity, "online");
    assert.equal(snapshot.detail, "older observed online");
    assert.equal(snapshot.observedAtMs, 100);
    orchestrator.shutdown();
  });
});

test("agent activity kernel arbitration enabled: same-authority out-of-order observed signals converge by observedAtMs", () => {
  withAgentActivityKernelEnv({ RAFT_ENABLE_AGENT_ACTIVITY_KERNEL_ARBITRATION: "1" }, () => {
    const storeA = new InMemoryReplicaStateStore();
    const orchestratorA = new DeterministicAgentOrchestrator(storeA, new FakeClock());
    (orchestratorA as any).broadcastActivity(
      "agent-1",
      "working",
      "newer observed work",
      "running_command",
      undefined,
      200,
      {
        observedAtMs: 200,
        arbitration: { observationClass: "observed", signalSite: "daemon_ingest" },
      },
    );
    const staleResult = (orchestratorA as any).broadcastActivity(
      "agent-1",
      "online",
      "older observed online",
      "none",
      undefined,
      300,
      {
        observedAtMs: 100,
        arbitration: { observationClass: "observed", signalSite: "daemon_ingest" },
      },
    );

    const snapshotA = (orchestratorA as any).agentActivity.get("agent-1");
    assert.equal(staleResult.action, "kernel-preserve");
    assert.equal(snapshotA.activity, "working");
    assert.equal(snapshotA.detail, "newer observed work");
    assert.equal(snapshotA.observedAtMs, 200);
    assert.equal(snapshotA.updatedAt, 200, "stale preserve must not re-stamp processing time");
    assert.equal(storeA.agentActivities.get("agent-1")?.activity, "working");
    orchestratorA.shutdown();

    const orchestratorB = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), new FakeClock());
    (orchestratorB as any).broadcastActivity(
      "agent-1",
      "online",
      "older observed online",
      "none",
      undefined,
      300,
      {
        observedAtMs: 100,
        arbitration: { observationClass: "observed", signalSite: "daemon_ingest" },
      },
    );
    (orchestratorB as any).broadcastActivity(
      "agent-1",
      "working",
      "newer observed work",
      "running_command",
      undefined,
      200,
      {
        observedAtMs: 200,
        arbitration: { observationClass: "observed", signalSite: "daemon_ingest" },
      },
    );

    const snapshotB = (orchestratorB as any).agentActivity.get("agent-1");
    assert.equal(snapshotB.activity, "working");
    assert.equal(snapshotB.detail, "newer observed work");
    assert.equal(snapshotB.observedAtMs, 200);
    orchestratorB.shutdown();
  });
});

test("agent activity kernel arbitration enabled: synthetic/replayed writers preserve observed busy truth without refreshing freshness", () => {
  withAgentActivityKernelEnv({ RAFT_ENABLE_AGENT_ACTIVITY_KERNEL_ARBITRATION: "1" }, () => {
    const store = new InMemoryReplicaStateStore();
    const orchestrator = new DeterministicAgentOrchestrator(store, new FakeClock());
    (orchestrator as any).broadcastActivity(
      "agent-1",
      "working",
      "observed busy",
      "running_command",
      undefined,
      200,
      {
        observedAtMs: 200,
        arbitration: { observationClass: "observed", signalSite: "daemon_ingest" },
      },
    );
    const syntheticResult = (orchestrator as any).broadcastActivity(
      "agent-1",
      "online",
      "",
      "idle",
      undefined,
      300,
      {
        observedAtMs: 300,
        arbitration: { observationClass: "synthetic", signalSite: "ready_online" },
      },
    );

    const snapshot = (orchestrator as any).agentActivity.get("agent-1");
    assert.equal(syntheticResult.action, "kernel-preserve");
    assert.equal(snapshot.activity, "working");
    assert.equal(snapshot.detail, "observed busy");
    assert.equal(snapshot.observedAtMs, 200);
    assert.equal(snapshot.updatedAt, 200, "synthetic preserve must not refresh processing-time freshness");
    assert.equal(store.agentActivities.get("agent-1")?.activity, "working");
    orchestrator.shutdown();
  });
});

test("agent activity kernel arbitration disable env overrides enable env as the emergency escape hatch", () => {
  withAgentActivityKernelEnv({
    RAFT_ENABLE_AGENT_ACTIVITY_KERNEL_ARBITRATION: "1",
    RAFT_DISABLE_AGENT_ACTIVITY_KERNEL_ARBITRATION: "1",
  }, () => {
    const orchestrator = new DeterministicAgentOrchestrator(new InMemoryReplicaStateStore(), new FakeClock());
    (orchestrator as any).broadcastActivity(
      "agent-1",
      "working",
      "newer observed work",
      "running_command",
      undefined,
      200,
      {
        observedAtMs: 200,
        arbitration: { observationClass: "observed", signalSite: "daemon_ingest" },
      },
    );
    const result = (orchestrator as any).broadcastActivity(
      "agent-1",
      "online",
      "older observed online",
      "none",
      undefined,
      300,
      {
        observedAtMs: 100,
        arbitration: { observationClass: "observed", signalSite: "daemon_ingest" },
      },
    );

    const snapshot = (orchestrator as any).agentActivity.get("agent-1");
    assert.notEqual(result.action, "kernel-preserve");
    assert.equal(snapshot.activity, "online");
    assert.equal(snapshot.detail, "older observed online");
    assert.equal(snapshot.observedAtMs, 100);
    orchestrator.shutdown();
  });
});

test("lifecycle-v2 gamma shadow: stale-sweep synthetic repair emits the synthetic-rejection verdict, and keep-current emits none (task #460 gamma witness 2)", async () => {
  // The legacy online candidate remains visible in the shadow for calibration,
  // but canonical application now agrees with the kernel and preserves truth.
  const { sink, tracer } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(120_000);
  const orchestrator = new StaleActivityApplyDeterministicOrchestrator(new InMemoryReplicaStateStore(), clock, tracer);
  const now = clock.now();
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "stuck",
    detailKind: "other",
    updatedAt: now - 91_000,
  });

  const collectVerdicts = () =>
    sink.getAllSpans()
      .filter((span) => span.name === "server.agent.synthetic_repair.apply")
      .flatMap((span) => span.events)
      .filter((event) => event.name === "lifecycle_v2.shadow_verdict")
      .map((event) => event.attrs ?? {});

  // keep-current applies no repair — it must also emit no verdict (the shadow
  // measures applied whitewashes, not considered ones).
  orchestrator.callApplyStaleActivitySweepAction("keep-current", "agent-1", now);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(collectVerdicts().length, 0, "keep-current must not emit a shadow verdict");

  orchestrator.callApplyStaleActivitySweepAction("sweep-online", "agent-1", now);
  await new Promise((resolve) => setImmediate(resolve));
  const verdicts = collectVerdicts();
  assert.equal(verdicts.length, 1, "sweep-online repair must emit exactly one shadow verdict");
  const verdict = verdicts[0];
  assert.equal(verdict.shadow_signal_site, "synthetic_repair");
  assert.equal(verdict.shadow_observation_class, "synthetic_diagnostic");
  assert.equal(verdict.shadow_action, "preserve");
  assert.equal(verdict.shadow_reason, "synthetic_no_authority");
  assert.equal(verdict.shadow_projection, "working", "kernel preserves the busy truth");
  assert.equal(verdict.shadow_legacy_outcome, "online", "shadow retains the rejected legacy online candidate");
  assert.equal(verdict.shadow_agree, false, "shadow still measures the retired whitewash heuristic");
  assert.equal(verdict.shadow_direction, "downgrade");
  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), {
    activity: "working",
    detail: "stuck",
    detailKind: "other",
    updatedAt: now - 91_000,
  });

  orchestrator.shutdown();
});

test("lifecycle-v2 gamma shadow: transient-normalization repair carries the same synthetic-rejection verdict from the local-cache branch (task #460 gamma witness 3)", async () => {
  // Same whitewash family as witness 2 via the read-path normalization; the
  // sub-kind lives on the span's repair_kind (transient_normalization), the
  // closed site enum stays coarse.
  const { sink, tracer } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(120_000);
  const orchestrator = new StaleTransientApplyDeterministicOrchestrator(new InMemoryReplicaStateStore(), clock, tracer);
  const now = clock.now();
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "thinking",
    detail: "stuck-thinking",
    detailKind: "other",
    updatedAt: now - 91_000,
  });

  const served = orchestrator.callApplyStaleTransientNormalizationAction("normalize-online", "agent-1", "local-cache", now);
  await new Promise((resolve) => setImmediate(resolve));

  const repairSpans = sink.getAllSpans().filter((span) => span.name === "server.agent.synthetic_repair.apply");
  assert.equal(repairSpans.length, 1, "local-cache normalization must open exactly one repair span");
  assert.equal(repairSpans[0].attrs?.repair_kind, "transient_normalization", "sub-kind rides on the span, not the site enum");
  const verdicts = repairSpans
    .flatMap((span) => span.events)
    .filter((event) => event.name === "lifecycle_v2.shadow_verdict")
    .map((event) => event.attrs ?? {});
  assert.equal(verdicts.length, 1, "normalization repair must emit exactly one shadow verdict");
  const verdict = verdicts[0];
  assert.equal(verdict.shadow_signal_site, "synthetic_repair");
  assert.equal(verdict.shadow_observation_class, "synthetic_diagnostic");
  assert.equal(verdict.shadow_action, "preserve");
  assert.equal(verdict.shadow_reason, "synthetic_no_authority");
  assert.equal(verdict.shadow_prior_projection, "thinking");
  assert.equal(verdict.shadow_legacy_outcome, "online");
  assert.equal(verdict.shadow_agree, false, "value-axis disagree from the thinking side too (direction symmetry with witness 2's working side)");
  assert.equal(verdict.shadow_direction, "downgrade");
  assert.deepEqual(served, { activity: "online", activityDetail: "" });
  assert.deepEqual((orchestrator as any).agentActivity.get("agent-1"), {
    activity: "thinking",
    detail: "stuck-thinking",
    detailKind: "other",
    updatedAt: now - 91_000,
  });

  orchestrator.shutdown();
});

test("gamma-2 starting_resolve shadow: the resolve-race stomp carries a refusing verdict (task #460 gamma-2, Kai calibration v2 §B)", () => {
  // g1 Phase A pinned: launch-ready starting-resolve raced the first real
  // working and stomped it with online via arrival-order LWW. Kai v2 §B:
  // "observed(fresh) > synthetic-lifecycle online" — 意图态不得覆盖事实态.
  // The kernel refuses the stomp (preserve/synthetic_no_authority); legacy
  // still broadcasts online (behavior-neutral shadow, the #161 repair
  // untouched) — that pair IS the red/green stake for the gamma demolition.
  const { sink, tracer } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(60_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock, tracer);
  seedActiveAgent(orchestrator);
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "Starting…",
    detailKind: "starting",
    updatedAt: clock.now() - 1_000,
  });

  (orchestrator as any).maybeResolveStartingActivity("agent-1");

  const verdicts = sink.getAllSpans()
    .filter((span) => span.name === "server.agent.activity_writer.shadow")
    .flatMap((span) => span.events)
    .filter((event) => event.name === "lifecycle_v2.shadow_verdict")
    .map((event) => event.attrs ?? {});
  assert.equal(verdicts.length, 1, "spanless resolve caller must fall back to the dedicated writer-shadow span (Phase-B lesson)");
  const verdict = verdicts[0];
  assert.equal(verdict.shadow_signal_site, "starting_resolve");
  assert.equal(verdict.shadow_observation_class, "synthetic_diagnostic");
  assert.equal(verdict.shadow_action, "preserve", "kernel refuses synthetic authority over the current projection");
  assert.equal(verdict.shadow_reason, "synthetic_no_authority");
  assert.equal(verdict.shadow_starting_affordance, true, "prior IS the Starting snapshot — affordance bit from detailKind truth source");
  assert.equal(verdict.shadow_legacy_outcome, "online");
  // Legacy half unchanged: the #161 resolve still broadcast online.
  const after = (orchestrator as any).agentActivity.get("agent-1");
  assert.equal(after?.activity, "online", "legacy resolve behavior must be untouched (shadow-only change)");

  orchestrator.shutdown();
});

test("gamma-2 ready_online shadow: machine-ready reconcile carries its site verdict on the caller span (task #460 gamma-2)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(60_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock, tracer);
  seedActiveAgent(orchestrator);
  // Stale offline snapshot: ready reconcile's guards (fresh-busy skip) must
  // not fire, so the broadcast leg runs.
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "offline",
    detail: "",
    detailKind: "none",
    updatedAt: clock.now() - 120_000,
  });

  await (orchestrator as any).broadcastReadyOnline("agent-1");

  const verdicts = sink.getAllSpans()
    .flatMap((span) => span.events)
    .filter((event) => event.name === "lifecycle_v2.shadow_verdict")
    .map((event) => event.attrs ?? {});
  assert.equal(verdicts.length, 1, "ready_online broadcast leg must emit exactly one verdict");
  assert.equal(verdicts[0].shadow_signal_site, "ready_online");
  assert.equal(verdicts[0].shadow_observation_class, "synthetic_diagnostic");
  assert.equal(verdicts[0].shadow_prior_projection, "offline");
  assert.equal(verdicts[0].shadow_legacy_outcome, "online");

  orchestrator.shutdown();
});

test("gamma-2 ready_online shadow: fresh-busy guard emits NO verdict (skip is not a write)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(60_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock, tracer);
  seedActiveAgent(orchestrator);
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "Running tests",
    detailKind: "running_command",
    updatedAt: clock.now() - 5_000,
  });

  await (orchestrator as any).broadcastReadyOnline("agent-1");

  const verdicts = sink.getAllSpans()
    .flatMap((span) => span.events)
    .filter((event) => event.name === "lifecycle_v2.shadow_verdict");
  assert.equal(verdicts.length, 0, "fresh-busy skip path performs no map write, so no verdict");
  const after = (orchestrator as any).agentActivity.get("agent-1");
  assert.equal(after?.activity, "working", "fresh busy must be preserved by the guard");

  orchestrator.shutdown();
});

test("M-22 hint_resolution read-through emits no replay writer shadow and leaves local authority unchanged", () => {
  const { sink, tracer } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(60_000);
  const orchestrator = new ActivityHintApplyDeterministicOrchestrator(new InMemoryReplicaStateStore(), clock, tracer);
  const snapshot = { activity: "working" as AgentActivityKind, detail: "Mirrored", detailKind: "running_command" as AgentActivityDetailKind, updatedAt: clock.now() - 10_000 };

  const visible = orchestrator.callApplyActivityHintResolutionAction("return-read-through-snapshot", "agent-1", snapshot);

  const verdicts = sink.getAllSpans()
    .filter((span) => span.name === "server.agent.activity_writer.shadow")
    .flatMap((span) => span.events)
    .filter((event) => event.name === "lifecycle_v2.shadow_verdict")
    .map((event) => event.attrs ?? {});
  assert.equal(verdicts.length, 0, "read-through performs no writer attempt, so the M-22 shadow carrier disappears");
  assert.deepEqual(visible, { activity: "working", activityDetail: "Mirrored" });
  assert.equal((orchestrator as any).agentActivity.get("agent-1"), undefined);

  orchestrator.shutdown();
});

test("gamma-2 runtime_error shadow pair: observed error set, synthetic online restore (task #460 gamma-2)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(60_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock, tracer);
  seedActiveAgent(orchestrator);
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "Running tests",
    detailKind: "running_command",
    updatedAt: clock.now() - 1_000,
  });

  await (orchestrator as any).rememberRuntimeError("agent-1", {
    message: "Provider authentication failed",
    at: new Date(clock.now()).toISOString(),
    launchId: "L-err",
    actionRequired: true,
  });
  await (orchestrator as any).clearLastRuntimeError("agent-1");

  const verdicts = sink.getAllSpans()
    .filter((span) => span.name === "server.agent.activity_writer.shadow")
    .flatMap((span) => span.events)
    .filter((event) => event.name === "lifecycle_v2.shadow_verdict")
    .map((event) => event.attrs ?? {});
  assert.equal(verdicts.length, 2, "error set + online restore = exactly two writer verdicts");
  // Error set: daemon-reported ground truth on its own axis (Kai v2 §B:
  // runtime_error is the authoritative writer of its axis, not suppressed).
  assert.equal(verdicts[0].shadow_signal_site, "runtime_error");
  assert.equal(verdicts[0].shadow_observation_class, "runtime_lifecycle_observation");
  assert.equal(verdicts[0].shadow_projection, "error");
  assert.equal(verdicts[0].shadow_prior_projection, "working");
  // Restore: server-derived write, no observation behind it.
  assert.equal(verdicts[1].shadow_signal_site, "runtime_error");
  assert.equal(verdicts[1].shadow_observation_class, "synthetic_diagnostic");
  assert.equal(verdicts[1].shadow_prior_projection, "error");
  assert.equal(verdicts[1].shadow_legacy_outcome, "online");

  orchestrator.shutdown();
});

test("gamma-2.1 slock_action_status contrast pair: explicit transition = control authority, history append = plain synthetic (task #460, Kai v3 \u00a7B)", () => {
  // Leiysky's gamma-2 blocker: the control-command family must not be filed
  // under no_authority. Both action AND reason are asserted on both sides
  // (the bare-site assert was how the contradiction passed silently).
  const { sink, tracer } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(60_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock, tracer);
  seedActiveAgent(orchestrator);
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "online",
    detail: "",
    detailKind: "none",
    updatedAt: clock.now() - 1_000,
  });

  // Explicit status transition (SMR-006 statusEntry family): authorized
  // control command, its own axis's authoritative writer.
  (orchestrator as any).broadcastRaftAction("agent-1", {
    title: "Send draft held",
    text: "target: #general",
    activity: "working",
    activityDetail: "Send draft held",
  });
  // History append (CLI action record): claims no new value.
  (orchestrator as any).broadcastRaftAction("agent-1", {
    title: "Message sent",
    text: "target: #general",
  });

  const verdicts = sink.getAllSpans()
    .filter((span) => span.name === "server.agent.activity_writer.shadow")
    .flatMap((span) => span.events)
    .filter((event) => event.name === "lifecycle_v2.shadow_verdict")
    .map((event) => event.attrs ?? {});
  assert.equal(verdicts.length, 2, "one verdict per family");

  const explicit = verdicts[0];
  assert.equal(explicit.shadow_signal_site, "slock_action_status");
  assert.equal(explicit.shadow_observation_class, "control_intent", "explicit transition is an authorized control command");
  assert.equal(explicit.shadow_action, "replace", "control command legally replaces on its own axis");
  assert.equal(explicit.shadow_reason, "control_command_authority", "must NOT be filed under no_authority");
  assert.equal(explicit.shadow_prior_projection, "online");
  assert.equal(explicit.shadow_legacy_outcome, "working");
  assert.equal(explicit.shadow_agree, true, "kernel and legacy agree: the command applies");

  const append = verdicts[1];
  assert.equal(append.shadow_signal_site, "slock_action_status");
  assert.equal(append.shadow_observation_class, "synthetic_diagnostic", "history append claims no new value");
  assert.equal(append.shadow_action, "preserve");
  assert.equal(append.shadow_reason, "synthetic_no_authority");

  orchestrator.shutdown();
});

test("gamma-3 writer registry excludes all no-authority synthetic repair diagnostics (task #499)", () => {
  // Data-shape sanity for the closure contract (the CI grep-ratchet lives
  // in skyzh's lane; this pins the registry the ratchet consumes). NOT a
  // runtime-coverage proof — the shadow_verdict stream is (proxy vs target
  // kept separate on purpose). gamma-3 split the coarse plan-path row into
  // handler-accept (daemon_ingest) + writer-seam (lifecycle_plan).
  assert.equal(AGENT_ACTIVITY_WRITER_REGISTRY.length, 9, "writer registry denominator changed — update the ratchet + readtable together");
  const sites = new Set(AGENT_ACTIVITY_WRITER_REGISTRY.map((w) => w.site));
  assert.deepEqual(
    [...sites].sort(),
    ["daemon_ingest", "delivery_ack", "hint_resolution", "lifecycle_plan", "ready_online", "runtime_error", "slock_action_status", "starting_resolve"],
    "registry must span exactly the activity-writer sites; preserve and synthetic-repair sites are diagnostic-only",
  );
  const methods = AGENT_ACTIVITY_WRITER_REGISTRY.map((w) => w.method);
  assert.equal(new Set(methods).size, methods.length, "duplicate writer registration");
});

test("gamma-3 lifecycle_plan shadow: machine-disconnect offline write carries a verdict (g2 break-1 red/green, task #460)", async () => {
  // g2 invariant-#7 first catch: the disconnect plan wrote offline into the
  // serving map with zero trace. The writer seam must now emit
  // site=lifecycle_plan + plan_kind=machine_disconnected; the kernel's
  // honest verdict on the axis-crossing is preserve/synthetic_no_authority
  // ("machine gone" is not knowledge of the agent axis) while legacy
  // asserts offline — a true measured divergence, not a bug in the shadow.
  const { sink, tracer } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(60_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock, tracer);
  seedActiveAgent(orchestrator);
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "Running tests",
    detailKind: "running_command",
    updatedAt: clock.now() - 1_000,
  });

  const { createAgentLifecycleEvent } = await import("./agentLifecycleEvents.js");
  const { reduceMachineDisconnectLifecycle, buildAgentLifecycleStateSnapshot } = await import("./agentLifecycleReducer.js");
  const { applyAgentLifecycleProjectionPlan } = await import("./agentLifecycleProjectionWriter.js");
  const plan = reduceMachineDisconnectLifecycle({
    activityDedupeKey: "agent:agent-1:disconnect:test",
    event: createAgentLifecycleEvent({
      serverId: "server-1",
      agentId: "agent-1",
      eventType: "machine_disconnected",
      actor: "server",
      source: "server",
      reason: "machine_disconnect",
      correlationId: "agent:agent-1:disconnect:test",
      occurredAt: new Date(clock.now()),
    }),
    state: buildAgentLifecycleStateSnapshot({ dbStatus: "active", machineReachability: "unreachable" }),
  });
  await applyAgentLifecycleProjectionPlan(plan, (orchestrator as any).lifecycleProjectionWriterDeps());

  const verdicts = sink.getAllSpans()
    .filter((span) => span.name === "server.agent.activity_writer.shadow")
    .flatMap((span) => span.events)
    .filter((event) => event.name === "lifecycle_v2.shadow_verdict")
    .map((event) => event.attrs ?? {});
  assert.equal(verdicts.length, 1, "disconnect plan emit must carry exactly one writer verdict");
  const verdict = verdicts[0];
  assert.equal(verdict.shadow_signal_site, "lifecycle_plan");
  assert.equal(verdict.shadow_plan_kind, "machine_disconnected", "sub-family = closed event type");
  assert.equal(verdict.shadow_observation_class, "synthetic_diagnostic", "axis-crossing derivation, not an agent-axis observation");
  assert.equal(verdict.shadow_action, "preserve");
  assert.equal(verdict.shadow_reason, "synthetic_no_authority");
  assert.equal(verdict.shadow_prior_projection, "working");
  assert.equal(verdict.shadow_legacy_outcome, "offline");
  assert.equal(verdict.shadow_agree, false, "legacy asserts offline; kernel says cannot-know — the divergence worth measuring");
  // Legacy behavior untouched: offline actually landed in the map.
  assert.equal((orchestrator as any).agentActivity.get("agent-1")?.activity, "offline", "legacy disconnect write must be unchanged");

  orchestrator.shutdown();
});

test("gamma-3 lifecycle_plan shadow: manual-stop plan classifies control (task #460)", async () => {
  const { sink, tracer } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(60_000);
  const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock, tracer);
  seedActiveAgent(orchestrator);
  (orchestrator as any).agentActivity.set("agent-1", {
    activity: "working",
    detail: "Running tests",
    detailKind: "running_command",
    updatedAt: clock.now() - 1_000,
  });

  const { createAgentLifecycleEvent } = await import("./agentLifecycleEvents.js");
  const { reduceStopLifecycle, buildAgentLifecycleStateSnapshot } = await import("./agentLifecycleReducer.js");
  const { applyAgentLifecycleProjectionPlan } = await import("./agentLifecycleProjectionWriter.js");
  const plan = reduceStopLifecycle({
    activityDedupeKey: "agent:agent-1:stop:test",
    event: createAgentLifecycleEvent({
      serverId: "server-1",
      agentId: "agent-1",
      eventType: "manual_stop_requested",
      actor: "human",
      source: "web",
      reason: "manual_stop",
      correlationId: "agent:agent-1:stop:test",
      occurredAt: new Date(clock.now()),
    }),
    nextStatus: "stopped",
    state: buildAgentLifecycleStateSnapshot({ dbStatus: "active" }),
  } as any);
  await applyAgentLifecycleProjectionPlan(plan, (orchestrator as any).lifecycleProjectionWriterDeps());

  const verdicts = sink.getAllSpans()
    .filter((span) => span.name === "server.agent.activity_writer.shadow")
    .flatMap((span) => span.events)
    .filter((event) => event.name === "lifecycle_v2.shadow_verdict")
    .map((event) => event.attrs ?? {});
  assert.ok(verdicts.length >= 1, "stop plan emit must carry a writer verdict when it emits visible activity");
  const verdict = verdicts[0];
  assert.equal(verdict.shadow_signal_site, "lifecycle_plan");
  assert.equal(verdict.shadow_plan_kind, "manual_stop_requested");
  assert.equal(verdict.shadow_observation_class, "control_intent", "authorized command = its axis's authoritative writer");
  assert.equal(verdict.shadow_action, "replace");
  assert.equal(verdict.shadow_reason, "control_command_authority");

  orchestrator.shutdown();
});

// --- task #460 confluence stake (re-anchored from saber/460-plan-interleave-repro) ---
//
// The original stake (e47960ccb) modeled the serving map as a bare Map inside
// stub deps, so it could only turn green via a writer-layer critical-section
// fix. The shipped fix (#3909) landed one layer lower: kernel-arbitrated
// serving-map writes inside broadcastActivity — a surface the stub bypasses,
// leaving the old stake red for stub-fidelity reasons, not product reasons.
// These two tests state the SAME acceptance property against the real write
// path (reducer plan -> applyAgentLifecycleProjectionPlan -> real writer deps
// -> broadcastActivity -> kernel arbitration), and anchor oracle validity by
// asserting the legacy (flag-off) path stays arrival-order dependent.

async function runStopDisconnectBothOrders(): Promise<{
  finalA: { activity?: string; detail?: string };
  finalB: { activity?: string; detail?: string };
}> {
  const { createAgentLifecycleEvent } = await import("./agentLifecycleEvents.js");
  const { reduceStopLifecycle, reduceMachineDisconnectLifecycle, buildAgentLifecycleStateSnapshot } =
    await import("./agentLifecycleReducer.js");
  const { applyAgentLifecycleProjectionPlan } = await import("./agentLifecycleProjectionWriter.js");

  async function run(order: "stop-first" | "disconnect-first") {
    const { tracer } = makeDeterministicTracer();
    const clock = new FakeClock();
    clock.advance(60_000);
    const orchestrator = new PersistedActivityLogDeterministicOrchestrator(new Map(), clock, tracer);
    seedActiveAgent(orchestrator);
    (orchestrator as any).agentActivity.set("agent-1", {
      activity: "working",
      detail: "Running tests",
      detailKind: "running_command",
      updatedAt: clock.now() - 1_000,
    });
    const baseEvent = {
      serverId: "server-1",
      agentId: "agent-1",
      correlationId: "agent:agent-1:confluence:test",
      occurredAt: new Date(clock.now()),
    };
    const stopPlan = reduceStopLifecycle({
      activityDedupeKey: "agent:agent-1:stop:confluence",
      event: createAgentLifecycleEvent({
        ...baseEvent,
        eventType: "manual_stop_requested",
        actor: "human",
        source: "web",
        reason: "manual_stop",
      }),
      nextStatus: "stopped",
      state: buildAgentLifecycleStateSnapshot({ dbStatus: "active" }),
    } as any);
    const disconnectPlan = reduceMachineDisconnectLifecycle({
      activityDedupeKey: "agent:agent-1:disconnect:confluence",
      event: createAgentLifecycleEvent({
        ...baseEvent,
        eventType: "machine_disconnected",
        actor: "server",
        source: "server",
        reason: "machine_disconnect",
      }),
      state: buildAgentLifecycleStateSnapshot({ dbStatus: "active", machineReachability: "unreachable" }),
    });
    const deps = (orchestrator as any).lifecycleProjectionWriterDeps();
    const [first, second] = order === "stop-first" ? [stopPlan, disconnectPlan] : [disconnectPlan, stopPlan];
    await applyAgentLifecycleProjectionPlan(first, deps);
    await applyAgentLifecycleProjectionPlan(second, deps);
    const snapshot = (orchestrator as any).agentActivity.get("agent-1") ?? {};
    orchestrator.shutdown();
    return { activity: snapshot.activity, detail: snapshot.detail };
  }

  return { finalA: await run("stop-first"), finalB: await run("disconnect-first") };
}

// withAgentActivityKernelEnv restores env in a synchronous finally, so it
// cannot wrap an async body (env would revert at the first await). These
// tests manage the env keys across the full await chain instead.
async function withKernelEnvAsync<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of AGENT_ACTIVITY_KERNEL_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  if (enabled) process.env.RAFT_ENABLE_AGENT_ACTIVITY_KERNEL_ARBITRATION = "1";
  try {
    return await fn();
  } finally {
    for (const key of AGENT_ACTIVITY_KERNEL_ENV_KEYS) {
      const prior = previous.get(key);
      if (prior === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prior;
      }
    }
  }
}

test("task #460 confluence stake (re-anchored): stop x disconnect converge order-independently under kernel arbitration", async () => {
  await withKernelEnvAsync(true, async () => {
    const { finalA, finalB } = await runStopDisconnectBothOrders();
    assert.deepEqual(
      finalA,
      finalB,
      `order-dependence under arbitration: stop-first ends "${finalA.activity}/${finalA.detail}", ` +
        `disconnect-first ends "${finalB.activity}/${finalB.detail}" — authority must make arrival order irrelevant`,
    );
  });
});

test("task #460 confluence stake oracle validity: legacy (flag off) stays arrival-order dependent for the same pair", async () => {
  await withKernelEnvAsync(false, async () => {
    const { finalA, finalB } = await runStopDisconnectBothOrders();
    assert.notDeepEqual(
      finalA,
      finalB,
      "legacy LWW unexpectedly converged — if this now holds, the confluence stake above stops being a discriminating oracle and both must be re-examined",
    );
  });
});

// --- CC-004b: cross-replica stopped-agent read-through ---

test("getActivity returns offline/Stopped for a non-local agent when Redis says offline and DB says stopped (CC-004b)", async () => {
  // Bug A from tracing-consistency pilot: after POST /agents/:id/stop on
  // replica-1, replica-2's stale cache still has status: "active". Redis
  // correctly reports offline, but the old code's shouldTrustRecoveredOfflineHint
  // distrusts the hint because the cached status is active — making the agent
  // appear permanently online on the non-owning replica.
  // Fix: read-through to DB when Redis says offline for a non-local agent.
  const clock = new FakeClock();
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1"); // remote replica owns this machine

  class StoppedDbOrchestrator extends DeterministicAgentOrchestrator {
    protected override async loadAgentForDelivery(_agentId: string): Promise<any> {
      return {
        id: _agentId,
        serverId: "server-1",
        machineId: "machine-1",
        sessionId: null,
        status: "stopped",
        name: "agent-1",
        displayName: null,
        avatarUrl: null,
        description: null,
        model: "gpt-5",
        runtime: "codex",
        lastRuntimeError: null,
        reasoningEffort: null,
        envVars: null,
        executionMode: "cloud",
        deletedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    }
  }

  const orchestrator = new StoppedDbOrchestrator(store, clock);
  // Seed cache with stale status: "active" (this is the bug scenario —
  // non-owning replica never got the stop update).
  seedActiveAgent(orchestrator, "agent-1", "machine-1");

  // Redis mirror says offline (owning replica wrote this after the stop).
  store.agentActivities.set("agent-1", {
    activity: "offline",
    detail: "",
    detailKind: "other",
    updatedAt: clock.now(),
  });

  clock.advance(5_000);

  try {
    const activity = await orchestrator.getActivity("agent-1");
    assert.deepEqual(activity, { activity: "offline", activityDetail: "Stopped" });
  } finally {
    orchestrator.shutdown();
  }
});

test("getActivity read-through refreshes non-local stale stopped cache after restart (CC-004b inverse)", async () => {
  const clock = new FakeClock();
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1"); // remote replica owns this machine

  class ActiveDbOrchestrator extends DeterministicAgentOrchestrator {
    protected override async loadAgentForDelivery(_agentId: string): Promise<any> {
      return {
        id: _agentId,
        serverId: "server-1",
        machineId: "machine-1",
        sessionId: null,
        status: "active",
        name: "agent-1",
        displayName: null,
        avatarUrl: null,
        description: null,
        model: "gpt-5",
        runtime: "codex",
        lastRuntimeError: null,
        reasoningEffort: null,
        envVars: null,
        executionMode: "cloud",
        deletedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    }
  }

  const orchestrator = new ActiveDbOrchestrator(store, clock);
  // Non-owning replica still has the old stopped DB snapshot after the owner
  // restarted the agent and mirrored online activity to Redis.
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  (orchestrator as any).updateCache("agent-1", { status: "stopped" });

  store.agentActivities.set("agent-1", {
    activity: "online",
    detail: "",
    detailKind: "none",
    updatedAt: clock.now(),
  });

  clock.advance(5_000);

  try {
    const activity = await orchestrator.getActivity("agent-1");
    assert.deepEqual(activity, { activity: "online", activityDetail: "" });
    assert.equal((orchestrator as any).agentStateCache.get("agent-1")?.status, "active");
  } finally {
    orchestrator.shutdown();
  }
});

test("getActivity preserves crash detail after stale stopped cache is refreshed by restart (CC-004b inverse)", async () => {
  const clock = new FakeClock();
  const store = new InMemoryReplicaStateStore();
  store.machineReplicas.add("machine-1"); // remote replica owns this machine
  let dbStatus: "active" | "stopped" = "active";

  class MutableDbOrchestrator extends DeterministicAgentOrchestrator {
    protected override async loadAgentForDelivery(_agentId: string): Promise<any> {
      return {
        id: _agentId,
        serverId: "server-1",
        machineId: "machine-1",
        sessionId: null,
        status: dbStatus,
        name: "agent-1",
        displayName: null,
        avatarUrl: null,
        description: null,
        model: "gpt-5",
        runtime: "codex",
        lastRuntimeError: null,
        reasoningEffort: null,
        envVars: null,
        executionMode: "cloud",
        deletedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    }
  }

  const orchestrator = new MutableDbOrchestrator(store, clock);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  (orchestrator as any).updateCache("agent-1", { status: "stopped" });

  store.agentActivities.set("agent-1", {
    activity: "online",
    detail: "",
    detailKind: "none",
    updatedAt: clock.now(),
  });

  try {
    assert.deepEqual(await orchestrator.getActivity("agent-1"), { activity: "online", activityDetail: "" });
    assert.equal((orchestrator as any).agentStateCache.get("agent-1")?.status, "active");

    dbStatus = "stopped";
    clock.advance(1_000);
    store.agentActivities.set("agent-1", {
      activity: "offline",
      detail: "Crashed(SIGKILL)",
      detailKind: "runtime_error",
      updatedAt: clock.now(),
    });

    assert.deepEqual(await orchestrator.getActivity("agent-1"), {
      activity: "offline",
      activityDetail: "Crashed(SIGKILL)",
    });
  } finally {
    orchestrator.shutdown();
  }
});

// --- broadcastReadyOnline dedup guard ---

test("broadcastReadyOnline dedup guard skips second call within 1s window", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(5_000);
  const orchestrator = new ReadyReconcileDeterministicOrchestrator(new InMemoryReplicaStateStore(), clock, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  (orchestrator as any).updateCache("agent-1", { status: "inactive" });

  // First call: should broadcast.
  const span1 = tracer.startSpan("test.ready_1", { surface: "server", kind: "internal" });
  await orchestrator.callApplyReadyReconcileAction("machine-1", "agent-1", "mark-active-online", span1);
  span1.end("ok");
  await flushMicrotasks();

  // Second call within dedup window (clock not advanced): should be skipped.
  clock.advance(500); // 500ms < 1000ms dedup window
  (orchestrator as any).updateCache("agent-1", { status: "inactive" });
  const span2 = tracer.startSpan("test.ready_2", { surface: "server", kind: "internal" });
  await orchestrator.callApplyReadyReconcileAction("machine-1", "agent-1", "mark-active-online", span2);
  span2.end("ok");
  await flushMicrotasks();

  const allSpans = sink.getTrace(traceId);
  const readyEvents = allSpans
    .flatMap((s) => s.events)
    .filter((e) => e.name === "ready_online.resolve");

  assert.ok(readyEvents.length >= 2, "both calls must record a trace event");
  assert.equal(readyEvents[0].attrs?.outcome, "broadcast", "first call broadcasts");
  assert.equal(readyEvents[1].attrs?.outcome, "skip", "second call within window is deduped");
  assert.equal(readyEvents[1].attrs?.reason, "dedup_window");

  orchestrator.shutdown();
});

test("broadcastReadyOnline dedup guard allows call after window expires", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const clock = new FakeClock();
  clock.advance(5_000);
  const orchestrator = new ReadyReconcileDeterministicOrchestrator(new InMemoryReplicaStateStore(), clock, tracer);
  seedActiveAgent(orchestrator, "agent-1", "machine-1");
  seedMachineConnection(orchestrator, "machine-1", makeFakeWs());
  (orchestrator as any).updateCache("agent-1", { status: "inactive" });

  // First call: broadcasts.
  const span1 = tracer.startSpan("test.ready_1", { surface: "server", kind: "internal" });
  await orchestrator.callApplyReadyReconcileAction("machine-1", "agent-1", "mark-active-online", span1);
  span1.end("ok");
  await flushMicrotasks();

  // Advance past dedup window.
  clock.advance(1_500); // 1500ms > 1000ms dedup window
  (orchestrator as any).updateCache("agent-1", { status: "inactive" });
  const span2 = tracer.startSpan("test.ready_2", { surface: "server", kind: "internal" });
  await orchestrator.callApplyReadyReconcileAction("machine-1", "agent-1", "mark-active-online", span2);
  span2.end("ok");
  await flushMicrotasks();

  const allSpans = sink.getTrace(traceId);
  const readyEvents = allSpans
    .flatMap((s) => s.events)
    .filter((e) => e.name === "ready_online.resolve");

  assert.ok(readyEvents.length >= 2, "both calls must record a trace event");
  assert.equal(readyEvents[0].attrs?.outcome, "broadcast", "first call broadcasts");
  assert.equal(readyEvents[1].attrs?.outcome, "broadcast", "second call after window also broadcasts");

  orchestrator.shutdown();
});

// --- #4695: capabilities persist retry-until-success + single-writer -------
// The setup projection reads the persisted machines.runtimes column, so the
// client card + in-memory conn must only advance after the DB write lands. A
// transient persist failure is retried by the server itself on a capped
// backoff (it must NOT wait for the daemon to send another `ready`), and at most
// ONE persist is ever in flight per machine so an older write can never land
// after a newer one. These teeth pin: (1) retry-until-success with no second
// `ready`; (2) a newer payload supersedes an older pending retry; (3) disconnect
// cancels the timer; (4) while persist keeps failing the conn/card keep their
// old value and a next retry is always scheduled; (5) single-writer serialization
// — a newer `ready` while a persist is in flight does not start a concurrent
// write, and the latest payload is what finally lands in DB/conn/card; (6) the
// monotonic generation is never reused after an entry converges, so an old
// in-flight generation cannot ABA-match a fresh pending write.
class CapabilitiesPersistDeterministicOrchestrator extends DeterministicAgentOrchestrator {
  readonly emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  readonly persistCalls: Array<{ runtimes: string[]; hostname?: string }> = [];
  // When set, each persist blocks on a manually-resolved gate so a test can
  // control completion order and prove writes never overlap.
  readonly persistGates: Array<{ runtimes: string[]; settle: (err?: Error) => void }> = [];
  manualPersist = false;
  private persistCursor = 0;

  constructor(clock: TestClock, private readonly scriptedFailures: number) {
    super(new InMemoryReplicaStateStore(), clock);
    (this as unknown as { io: ReturnType<typeof makeFakeServerIO> }).io = makeFakeServerIO(this.emitted);
  }

  protected override async persistMachineCapabilities(
    _machineId: string,
    runtimes: string[],
    hostname?: string,
    _os?: string,
    _daemonVersion?: string | null,
  ): Promise<void> {
    const attemptIndex = this.persistCursor;
    this.persistCursor += 1;
    this.persistCalls.push({ runtimes, hostname });
    if (this.manualPersist) {
      await new Promise<void>((resolve, reject) => {
        this.persistGates.push({ runtimes, settle: (err) => (err ? reject(err) : resolve()) });
      });
      return;
    }
    if (attemptIndex < this.scriptedFailures) {
      throw new Error(`scripted persist failure #${attemptIndex + 1}`);
    }
  }

  seedConnection(machineId: string, serverId: string, runtimes: string[] | null = null): void {
    (this as unknown as { machineConnections: Map<string, unknown> }).machineConnections.set(machineId, {
      ws: { readyState: 1, send() {}, close() {} },
      machineId,
      serverId,
      principalKind: "computer",
      connectionEpochId: "epoch-1",
      heartbeatTimer: null,
      lastPong: 0,
      lastIngressAt: 0,
      daemonVersion: null,
      capabilities: new Set<string>(),
      runtimes,
      migrationTransport: null,
      shutdownIntent: null,
      computerVersion: null,
    });
  }

  callEnqueue(machineId: string, payload: { runtimes: string[]; hostname?: string; os?: string; daemonVersion?: string | null; computerVersion?: string | null }): void {
    // Fire-and-forget on purpose: the teeth drive convergence via waitForCondition
    // + the FakeClock, exactly as a failed first attempt + background retry would.
    void this.enqueueCapabilitiesPersist(machineId, payload);
  }

  callCancel(machineId: string): void {
    this.cancelPendingCapabilities(machineId);
  }

  connRuntimes(machineId: string): string[] | null {
    return (this as unknown as { machineConnections: Map<string, { runtimes: string[] | null }> }).machineConnections.get(machineId)?.runtimes ?? null;
  }

  private writeState(machineId: string): { timer: unknown; writing: boolean } | undefined {
    return (this as unknown as { capabilitiesWrites: Map<string, { timer: unknown; writing: boolean }> }).capabilitiesWrites.get(machineId);
  }

  hasPending(machineId: string): boolean {
    return this.writeState(machineId) != null;
  }

  hasScheduledTimer(machineId: string): boolean {
    const state = this.writeState(machineId);
    return state != null && state.timer != null;
  }

  isWriting(machineId: string): boolean {
    return this.writeState(machineId)?.writing === true;
  }

  generationSeq(machineId: string): number {
    return (this as unknown as { capabilitiesGenerationSeq: Map<string, number> }).capabilitiesGenerationSeq.get(machineId) ?? 0;
  }

  capabilitiesEmits(): Array<{ room: string; payload: { runtimes: string[] } }> {
    return this.emitted
      .filter((e) => e.event === "machine:capabilities")
      .map((e) => ({ room: e.room, payload: e.payload as { runtimes: string[] } }));
  }
}

test("#4695: capabilities persist retries until success without a second ready, then emits exactly once", async () => {
  const clock = new FakeClock();
  const orchestrator = new CapabilitiesPersistDeterministicOrchestrator(clock, 2);
  orchestrator.seedConnection("machine-1", "server-1");

  orchestrator.callEnqueue("machine-1", { runtimes: ["codex"] });
  // First attempt fails and schedules a retry; nothing is emitted yet.
  await waitForCondition(() => orchestrator.persistCalls.length >= 1 && orchestrator.hasScheduledTimer("machine-1"));
  assert.equal(orchestrator.capabilitiesEmits().length, 0, "no card before the DB write lands");
  assert.equal(orchestrator.connRuntimes("machine-1"), null, "conn not advanced before persist");

  // Second attempt (500ms backoff) also fails; still no card.
  await advanceClockAndWaitForCondition(clock, 500, () => orchestrator.persistCalls.length >= 2 && orchestrator.hasScheduledTimer("machine-1"));
  assert.equal(orchestrator.capabilitiesEmits().length, 0);

  // Third attempt (1000ms backoff) succeeds — no second `ready` was sent.
  await advanceClockAndWaitForCondition(clock, 1000, () => !orchestrator.hasPending("machine-1"));
  assert.equal(orchestrator.persistCalls.length, 3, "retried until the write landed");
  assert.equal(orchestrator.capabilitiesEmits().length, 1, "card emitted exactly once, on success");
  assert.deepEqual(orchestrator.connRuntimes("machine-1"), ["codex"]);
  assert.deepEqual(orchestrator.capabilitiesEmits()[0].payload.runtimes, ["codex"]);
  assert.equal(orchestrator.capabilitiesEmits()[0].room, "server:server-1");

  orchestrator.shutdown();
});

test("#4695: a newer ready supersedes the pending retry; the older payload never writes back", async () => {
  const clock = new FakeClock();
  // Only the first attempt (the older payload) fails; the superseding attempt succeeds.
  const orchestrator = new CapabilitiesPersistDeterministicOrchestrator(clock, 1);
  orchestrator.seedConnection("machine-1", "server-1");

  orchestrator.callEnqueue("machine-1", { runtimes: ["codex"] });
  await waitForCondition(() => orchestrator.persistCalls.length >= 1 && orchestrator.hasScheduledTimer("machine-1"));

  // Newer ready arrives before the older retry fires.
  orchestrator.callEnqueue("machine-1", { runtimes: ["claude"] });
  await waitForCondition(() => !orchestrator.hasPending("machine-1"));

  assert.equal(orchestrator.capabilitiesEmits().length, 1, "only the latest payload emits");
  assert.deepEqual(orchestrator.capabilitiesEmits()[0].payload.runtimes, ["claude"]);
  assert.deepEqual(orchestrator.connRuntimes("machine-1"), ["claude"], "older codex payload never reached conn");

  // The superseded (older) retry timer must not fire another persist.
  await advanceClockAndWaitForCondition(clock, 60_000, () => true);
  assert.equal(orchestrator.persistCalls.length, 2, "superseded timer did not re-persist the old payload");

  orchestrator.shutdown();
});

test("#4695: disconnect cancels the pending retry", async () => {
  const clock = new FakeClock();
  const orchestrator = new CapabilitiesPersistDeterministicOrchestrator(clock, 1_000);
  orchestrator.seedConnection("machine-1", "server-1");

  orchestrator.callEnqueue("machine-1", { runtimes: ["codex"] });
  await waitForCondition(() => orchestrator.persistCalls.length >= 1 && orchestrator.hasScheduledTimer("machine-1"));

  // Simulate the disconnect path (clearMachineConnection calls this).
  orchestrator.callCancel("machine-1");
  assert.ok(!orchestrator.hasPending("machine-1"), "pending cleared on disconnect");

  await advanceClockAndWaitForCondition(clock, 60_000, () => true);
  assert.equal(orchestrator.persistCalls.length, 1, "no retry after disconnect");
  assert.equal(orchestrator.capabilitiesEmits().length, 0);

  orchestrator.shutdown();
});

test("#4695: while persist keeps failing, conn/card keep their old value and a next retry stays scheduled", async () => {
  const clock = new FakeClock();
  const orchestrator = new CapabilitiesPersistDeterministicOrchestrator(clock, 1_000);
  orchestrator.seedConnection("machine-1", "server-1", ["old-runtime"]);

  orchestrator.callEnqueue("machine-1", { runtimes: ["codex"] });
  await waitForCondition(() => orchestrator.persistCalls.length >= 1 && orchestrator.hasScheduledTimer("machine-1"));

  // Drive several failed attempts (past the alert threshold of 5).
  let expected = orchestrator.persistCalls.length;
  for (let i = 0; i < 6; i += 1) {
    expected += 1;
    await advanceClockAndWaitForCondition(
      clock,
      60_000,
      () => orchestrator.persistCalls.length >= expected && orchestrator.hasScheduledTimer("machine-1"),
    );
  }

  assert.ok(orchestrator.persistCalls.length >= 7, "keeps retrying, no hard exhaust");
  assert.ok(orchestrator.hasScheduledTimer("machine-1"), "a next retry is always scheduled");
  assert.deepEqual(orchestrator.connRuntimes("machine-1"), ["old-runtime"], "conn keeps old value while persist fails");
  assert.equal(orchestrator.capabilitiesEmits().length, 0, "no card while persist fails");

  orchestrator.callCancel("machine-1");
  orchestrator.shutdown();
});

test("#4695: single-writer serialization — a newer ready mid-flight never overlaps, and the latest payload is what lands", async () => {
  const clock = new FakeClock();
  const orchestrator = new CapabilitiesPersistDeterministicOrchestrator(clock, 0);
  orchestrator.manualPersist = true;
  orchestrator.seedConnection("machine-1", "server-1");

  // A arrives → its persist starts and blocks on gate 0 (in flight).
  orchestrator.callEnqueue("machine-1", { runtimes: ["codex"] });
  await waitForCondition(() => orchestrator.persistGates.length >= 1);
  assert.deepEqual(orchestrator.persistGates[0].runtimes, ["codex"]);
  assert.ok(orchestrator.isWriting("machine-1"), "A's write is in flight");

  // B supersedes while A is still in flight. It must NOT start a second persist —
  // this is the whole point: an older write can never race a newer one to the DB.
  orchestrator.callEnqueue("machine-1", { runtimes: ["claude"] });
  await flushMicrotasks();
  assert.equal(orchestrator.persistGates.length, 1, "single writer: B did not start a concurrent persist while A was in flight");
  assert.equal(orchestrator.capabilitiesEmits().length, 0, "nothing emitted mid-flight");

  // A resolves → the single writer loops and only now starts B's persist (gate 1).
  orchestrator.persistGates[0].settle();
  await waitForCondition(() => orchestrator.persistGates.length >= 2);
  assert.deepEqual(orchestrator.persistGates[1].runtimes, ["claude"], "the second, serialized write is the latest payload");

  // B resolves → converge on the latest.
  orchestrator.persistGates[1].settle();
  await waitForCondition(() => !orchestrator.hasPending("machine-1"));

  // Writes happened strictly serially, latest last — so DB (last write), conn, and card all agree.
  assert.deepEqual(orchestrator.persistCalls.map((c) => c.runtimes), [["codex"], ["claude"]], "exactly two writes, serialized, latest last");
  assert.equal(orchestrator.capabilitiesEmits().length, 1, "emit exactly once, for the latest");
  assert.deepEqual(orchestrator.capabilitiesEmits()[0].payload.runtimes, ["claude"]);
  assert.deepEqual(orchestrator.connRuntimes("machine-1"), ["claude"], "no stale codex writeback");

  orchestrator.shutdown();
});

test("#4695: the monotonic generation is never reused after convergence (no ABA)", async () => {
  const clock = new FakeClock();
  const orchestrator = new CapabilitiesPersistDeterministicOrchestrator(clock, 0);
  orchestrator.manualPersist = true;
  orchestrator.seedConnection("machine-1", "server-1");

  // Cycle 1: A converges and clears the write entry.
  orchestrator.callEnqueue("machine-1", { runtimes: ["codex"] });
  await waitForCondition(() => orchestrator.persistGates.length >= 1);
  const genA = orchestrator.generationSeq("machine-1");
  orchestrator.persistGates[0].settle();
  await waitForCondition(() => !orchestrator.hasPending("machine-1"));
  assert.equal(orchestrator.capabilitiesEmits().length, 1);

  // Cycle 2: a fresh ready must get a STRICTLY GREATER generation (not reset to 1
  // from the emptied map), so a stale in-flight generation from cycle 1 could
  // never ABA-match this new pending write.
  orchestrator.callEnqueue("machine-1", { runtimes: ["claude"] });
  await waitForCondition(() => orchestrator.persistGates.length >= 2);
  const genB = orchestrator.generationSeq("machine-1");
  assert.ok(genB > genA, `generation must be monotonic across convergence (genA=${genA}, genB=${genB})`);

  // A third ready supersedes claude while it is in flight; generation keeps climbing.
  orchestrator.callEnqueue("machine-1", { runtimes: ["kimi"] });
  const genC = orchestrator.generationSeq("machine-1");
  assert.ok(genC > genB, "generation keeps increasing, never reused");

  orchestrator.persistGates[1].settle();            // claude write resolves → loop picks up latest
  await waitForCondition(() => orchestrator.persistGates.length >= 3);
  assert.deepEqual(orchestrator.persistGates[2].runtimes, ["kimi"], "loop persists the latest, not the superseded claude");
  orchestrator.persistGates[2].settle();
  await waitForCondition(() => !orchestrator.hasPending("machine-1"));

  assert.equal(orchestrator.capabilitiesEmits().length, 2, "one emit per converged cycle: codex then kimi");
  assert.deepEqual(orchestrator.capabilitiesEmits()[1].payload.runtimes, ["kimi"]);
  assert.deepEqual(orchestrator.connRuntimes("machine-1"), ["kimi"]);

  orchestrator.shutdown();
});

// Wraps the FakeClock so setTimeout returns a handle whose unref() is spied,
// letting us assert the retry timer is unref'd (a pending best-effort retry must
// never keep the process alive — see the full-suite exit that this guarantees).
class UnrefSpyClock extends FakeClock {
  unrefCount = 0;
  override setTimeout(fn: () => void, ms: number): IntervalHandle {
    const handle = super.setTimeout(fn, ms);
    return { ...handle, unref: () => { this.unrefCount += 1; } } as IntervalHandle;
  }
}

test("#4695: the backoff retry timer is unref'd so a pending retry never keeps the process alive", async () => {
  const clock = new UnrefSpyClock();
  const orchestrator = new CapabilitiesPersistDeterministicOrchestrator(clock, 1_000);
  orchestrator.seedConnection("machine-1", "server-1");

  orchestrator.callEnqueue("machine-1", { runtimes: ["codex"] });
  await waitForCondition(() => orchestrator.persistCalls.length >= 1 && orchestrator.hasScheduledTimer("machine-1"));

  assert.ok(clock.unrefCount >= 1, "the scheduled retry timer must be unref'd");

  orchestrator.callCancel("machine-1");
  orchestrator.shutdown();
});

test("#4695: disconnect while a write is in flight keeps writer ownership, then converges silently — a gone machine is never announced", async () => {
  const clock = new FakeClock();
  const orchestrator = new CapabilitiesPersistDeterministicOrchestrator(clock, 0);
  orchestrator.manualPersist = true;
  orchestrator.seedConnection("machine-1", "server-1");

  orchestrator.callEnqueue("machine-1", { runtimes: ["codex"] });
  await waitForCondition(() => orchestrator.persistGates.length >= 1 && orchestrator.isWriting("machine-1"));

  // Disconnect mid-write. Cancel must NOT delete the entry (that would let a
  // reconnect start a second concurrent writer); it marks it for the running loop.
  orchestrator.callCancel("machine-1");
  assert.ok(orchestrator.hasPending("machine-1"), "cancel during in-flight preserves writer ownership");

  // The in-flight write completes → the loop sees it was cancelled → no conn
  // update, no emit, entry cleared, no residual timer.
  orchestrator.persistGates[0].settle();
  await waitForCondition(() => !orchestrator.hasPending("machine-1"));

  assert.equal(orchestrator.capabilitiesEmits().length, 0, "a machine that disconnected mid-write is never announced");
  assert.equal(orchestrator.connRuntimes("machine-1"), null, "conn never advanced");
  assert.equal(orchestrator.persistCalls.length, 1, "exactly one write, no retry after disconnect");
  assert.ok(!orchestrator.hasScheduledTimer("machine-1"), "no residual timer");

  orchestrator.shutdown();
});

test("#4695: in-flight disconnect + reconnect only coalesces — persist never overlaps, the old write never emits, the new latest lands", async () => {
  const clock = new FakeClock();
  const orchestrator = new CapabilitiesPersistDeterministicOrchestrator(clock, 0);
  orchestrator.manualPersist = true;
  orchestrator.seedConnection("machine-1", "server-1");

  // Old connection's write is in flight.
  orchestrator.callEnqueue("machine-1", { runtimes: ["codex"] });
  await waitForCondition(() => orchestrator.persistGates.length >= 1 && orchestrator.isWriting("machine-1"));

  // Disconnect, then reconnect + a new `ready`, all while the old write is still
  // in flight. The new ready must COALESCE into the surviving writer, not start a
  // second persist.
  orchestrator.callCancel("machine-1");
  orchestrator.seedConnection("machine-1", "server-1"); // reconnect (fresh conn row)
  orchestrator.callEnqueue("machine-1", { runtimes: ["claude"] });
  await flushMicrotasks();
  assert.equal(orchestrator.persistGates.length, 1, "reconnect coalesces: no concurrent persist while the old write is in flight");

  // Old write completes: it must NOT emit (to the old or the new connection),
  // then the single writer serially persists the new latest.
  orchestrator.persistGates[0].settle();
  await waitForCondition(() => orchestrator.persistGates.length >= 2);
  assert.deepEqual(orchestrator.persistGates[1].runtimes, ["claude"], "serially persists the new latest after the old write drains");
  assert.equal(orchestrator.capabilitiesEmits().length, 0, "the old in-flight write never emits, even after reconnect");

  orchestrator.persistGates[1].settle();
  await waitForCondition(() => !orchestrator.hasPending("machine-1"));

  assert.equal(orchestrator.persistCalls.length, 2, "exactly two serial persists (old then new), never concurrent");
  assert.equal(orchestrator.capabilitiesEmits().length, 1, "only the new latest emits, exactly once");
  assert.deepEqual(orchestrator.capabilitiesEmits()[0].payload.runtimes, ["claude"]);
  assert.deepEqual(orchestrator.connRuntimes("machine-1"), ["claude"]);

  orchestrator.shutdown();
});

// ---------------------------------------------------------------------------
// task #356 / #5092 — authoritative upgrade-success projection.
// These two RED tests exercise the REAL machine.computerVersion persistence
// seam (pglite + machineService.recordMachineComputerVersion), NOT a mocked
// ordering flag, per the frozen 4-point contract and Hipp's caller-seam rule.
// Base frozen at 2c2bda97. Fix shape (archer): persist-before-emit reorder
// + an `ok && !rolledBack` guard on the version-persist branch.
// ---------------------------------------------------------------------------
class RealPersistUpgradeDoneOrchestrator extends DeterministicAgentOrchestrator {
  // Simulate a durable-write failure. recordReportedMachineComputerVersion
  // swallows the throw, so this models "persist failed" without crashing the
  // relay — the row must stay old and web must not claim the new version.
  failPersist = false;
  readonly persistCalls: Array<{ machineId: string; version: string | null | undefined }> = [];

  constructor(private readonly persistDelayMs = 0) {
    super();
  }

  // Hit the real durable write (optionally after a real delay on that write
  // path) so the emit->persist ordering is observed against production code,
  // not a sequence flag.
  protected override async persistMachineComputerVersion(
    machineId: string,
    computerVersion: string | null | undefined,
    reportedAt: Date,
  ): Promise<boolean> {
    this.persistCalls.push({ machineId, version: computerVersion });
    if (this.persistDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.persistDelayMs));
    }
    if (this.failPersist) {
      throw new Error("simulated durable computer-version write failure");
    }
    return recordMachineComputerVersion(machineId, computerVersion, reportedAt);
  }

  // A non-terminal result makes sendComputerLifecycleFailureReceipts early-return,
  // so the ok:false path does not depend on a seeded lifecycle-operation row and
  // the test isolates the version-persist double-write.
  protected override terminalizeComputerLifecycleOperation(): never {
    return { status: "queued" } as never;
  }

  // Ready-path deps that are not under test: the runtimes write and agent
  // reconcile. The `ready` handler still reaches the real version writer seam.
  protected override async persistMachineCapabilities() {}

  protected override async loadAgentsForReadyReconcile() {
    return [] as Awaited<ReturnType<DeterministicAgentOrchestrator["loadAgentForStart"]>>[];
  }
}

async function seedUpgradeProjectionMachine(initialVersion: string): Promise<MachineId> {
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `upgrade-projection-red-${suffix}@slock.test`,
    name: `upgrade-projection-red-${suffix}`,
    displayName: "Upgrade Projection RED",
    passwordHash: "test-hash",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Upgrade Projection RED", `upgrade-projection-red-${suffix}`, owner.id);
  const { machine } = await registerMachine(server.id, owner.id, "upgrade-projection-red-machine");
  await getDb().update(machines).set({
    computerVersion: initialVersion,
    computerVersionReportedAt: new Date(0),
  }).where(eq(machines.id, machine.id));
  return machine.id as MachineId;
}

test("RED #356 ②: failed upgrade:done carrying newVersion must not advance machine.computerVersion", async ({ db }) => {
    const machineId = await seedUpgradeProjectionMachine("1.0.0");
    const orchestrator = new RealPersistUpgradeDoneOrchestrator();
    (orchestrator as unknown as { io: ReturnType<typeof makeFakeServerIO> }).io = makeFakeServerIO([]);
    seedMachineConnection(orchestrator, machineId, makeFakeWs());

    await orchestrator.handleMachineMessage(machineId, {
      type: "computer:upgrade:done",
      requestId: "red-2",
      ok: false,
      rolledBack: false,
      newVersion: "9.9.9",
    } as MachineToServerMessage);

    const after = await getMachine(machineId);
    assert.equal(
      after?.computerVersion,
      "1.0.0",
      "a failed (ok:false) upgrade:done that still carries newVersion must NOT advance the durable version",
    );
    orchestrator.shutdown();
});

test("RED #356 ①: reload at the upgrade:done emit must already see the durable newVersion", async ({ db }) => {
    const machineId = await seedUpgradeProjectionMachine("1.0.0");
    const orchestrator = new RealPersistUpgradeDoneOrchestrator(50);
    let reloadPromise: Promise<void> = Promise.resolve();
    let versionSeenAtEmit: string | null | undefined = "unobserved";
    (orchestrator as unknown as { io: unknown }).io = {
      to() {
        return {
          emit(event: string) {
            if (event === "computer:upgrade:done") {
              // Web has just been told the operation is done; this models its reload.
              reloadPromise = getMachine(machineId).then((m) => {
                versionSeenAtEmit = m?.computerVersion;
              });
            }
          },
        };
      },
    };
    seedMachineConnection(orchestrator, machineId, makeFakeWs());

    await orchestrator.handleMachineMessage(machineId, {
      type: "computer:upgrade:done",
      requestId: "red-1",
      ok: true,
      newVersion: "2.0.0",
    } as MachineToServerMessage);
    await reloadPromise;

    assert.equal(
      versionSeenAtEmit,
      "2.0.0",
      "the reload triggered by the done emit must already read the durable newVersion (persist-before-emit)",
    );
    orchestrator.shutdown();
});

// GREEN matrix (Hipp flag 2/3) — the fix must satisfy all of these.
async function runUpgradeDone(
  orchestrator: RealPersistUpgradeDoneOrchestrator,
  machineId: MachineId,
  frame: Record<string, unknown>,
): Promise<void> {
  (orchestrator as unknown as { io: ReturnType<typeof makeFakeServerIO> }).io = makeFakeServerIO([]);
  seedMachineConnection(orchestrator, machineId, makeFakeWs());
  await orchestrator.handleMachineMessage(machineId, {
    type: "computer:upgrade:done",
    ...frame,
  } as MachineToServerMessage);
}

test("GREEN #356: rolled-back upgrade:done carrying newVersion must not advance the version", async ({ db }) => {
    const machineId = await seedUpgradeProjectionMachine("1.0.0");
    const orchestrator = new RealPersistUpgradeDoneOrchestrator();
    await runUpgradeDone(orchestrator, machineId, {
      requestId: "g-rollback",
      ok: true,
      rolledBack: true,
      newVersion: "9.9.9",
    });
    const after = await getMachine(machineId);
    assert.equal(after?.computerVersion, "1.0.0", "a rolled-back upgrade must not advance the durable version");
    assert.equal(orchestrator.persistCalls.length, 0, "the ok && !rolledBack guard must skip the write entirely");
    orchestrator.shutdown();
});

test("GREEN #356: persist failure keeps old version + still relays the done operation-fact; a real ready replay converges", async ({ db }) => {
    const machineId = await seedUpgradeProjectionMachine("1.0.0");
    const orchestrator = new RealPersistUpgradeDoneOrchestrator();
    const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
    (orchestrator as unknown as { io: ReturnType<typeof makeFakeServerIO> }).io = makeFakeServerIO(emitted);
    seedMachineConnection(orchestrator, machineId, makeFakeWs());

    // Persist throws (swallowed by recordReportedMachineComputerVersion): the
    // durable row must stay old, but the done frame is an operation-fact and
    // must still be relayed to web.
    orchestrator.failPersist = true;
    await orchestrator.handleMachineMessage(machineId, {
      type: "computer:upgrade:done",
      requestId: "g-fail",
      ok: true,
      newVersion: "2.0.0",
    } as MachineToServerMessage);
    assert.equal(
      (await getMachine(machineId))?.computerVersion,
      "1.0.0",
      "a swallowed persist failure must leave the durable row old — web must not optimistically claim the new version",
    );
    assert.equal(
      emitted.filter((e) => e.event === "computer:upgrade:done").length,
      1,
      "the done frame is an operation-fact and must still be relayed exactly once even when the version persist fails",
    );

    // Production fallback: the daemon re-reports via `ready` carrying the loaded
    // version; the same real writer seam (recordReportedMachineComputerVersion,
    // source "ready") converges the durable row — not a retried upgrade:done.
    orchestrator.failPersist = false;
    await orchestrator.handleMachineMessage(machineId, {
      type: "ready",
      runtimes: [],
      runningAgents: [],
      computerVersion: "2.0.0",
    } as MachineToServerMessage);
    assert.equal(
      (await getMachine(machineId))?.computerVersion,
      "2.0.0",
      "a real ready replay carrying the loaded version converges the durable row through the same writer seam",
    );
    orchestrator.shutdown();
});

test("GREEN #356: replaying the same successful done is idempotent and stays current", async ({ db }) => {
    const machineId = await seedUpgradeProjectionMachine("1.0.0");
    const orchestrator = new RealPersistUpgradeDoneOrchestrator();
    await runUpgradeDone(orchestrator, machineId, { requestId: "g-idem", ok: true, newVersion: "2.0.0" });
    await runUpgradeDone(orchestrator, machineId, { requestId: "g-idem", ok: true, newVersion: "2.0.0" });
    const after = await getMachine(machineId);
    assert.equal(after?.computerVersion, "2.0.0", "idempotent replay of the same done stays at the new version");
    orchestrator.shutdown();
});

test("GREEN #356: late-open reload after a successful done reads new; a done with no newVersion is a no-op", async ({ db }) => {
    const machineId = await seedUpgradeProjectionMachine("1.0.0");
    const orchestrator = new RealPersistUpgradeDoneOrchestrator();

    // Successful done → a reload opened AFTER it (late-open) reads the durable new version.
    await runUpgradeDone(orchestrator, machineId, { requestId: "g-late", ok: true, newVersion: "2.0.0" });
    assert.equal((await getMachine(machineId))?.computerVersion, "2.0.0", "late-open reload reads the durable new version");

    // already-current / no-new-ready: an ok done with no newVersion must not touch the row.
    const noVersion = new RealPersistUpgradeDoneOrchestrator();
    await runUpgradeDone(noVersion, machineId, { requestId: "g-none", ok: true });
    assert.equal((await getMachine(machineId))?.computerVersion, "2.0.0", "a done with no newVersion leaves the current version unchanged");
    assert.equal(noVersion.persistCalls.length, 0, "no newVersion → no write attempt");
    noVersion.shutdown();

    orchestrator.shutdown();
});
