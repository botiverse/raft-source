import type { AgentConfig } from "@botiverse/raft-shared";
import type { PendingStartRebind } from "./agentStartCoordinator.js";
import { AgentStatusTransitionTrace, type AgentStatusTransitionInput } from "./agentStatusTransitionTrace.js";

export type AgentRestartSnapshot = {
  config: AgentConfig;
  sessionId: string | null;
  launchId: string | null;
  /** Emitting process identity cached from the live AgentProcess when
   * available, so idle/restart handoff markers keep the L1<->L2 join
   * (#460 V3). */
  processInstanceId?: string;
};

export type AgentTerminalFailure = {
  detail: string;
  launchId: string | null;
};

export type AgentLifecycleRecord<SpawnFailBackoff = unknown, FingerprintFence = unknown> =
  | {
      kind: "queued";
      agentId: string;
      restartSnapshot?: AgentRestartSnapshot;
      pendingStartRebind?: PendingStartRebind;
      activityClientSeq?: number;
    }
  | {
      kind: "starting";
      agentId: string;
      restartSnapshot?: AgentRestartSnapshot;
      pendingStartRebind?: PendingStartRebind;
      activityClientSeq?: number;
    }
  | {
      kind: "running";
      agentId: string;
      restartSnapshot?: AgentRestartSnapshot;
      pendingStartRebind?: PendingStartRebind;
      pendingSpawnCause?: string;
      fingerprintFence?: FingerprintFence;
      activityClientSeq?: number;
    }
  | {
      kind: "idle";
      agentId: string;
      restartSnapshot: AgentRestartSnapshot;
      fingerprintFence?: FingerprintFence;
      activityClientSeq?: number;
    }
  | {
      kind: "cooldown";
      agentId: string;
      restartSnapshot: AgentRestartSnapshot;
      spawnFailBackoff: SpawnFailBackoff;
      fingerprintFence?: FingerprintFence;
      activityClientSeq?: number;
    }
  | {
      kind: "terminal";
      agentId: string;
      terminalFailure: AgentTerminalFailure;
      fingerprintFence?: FingerprintFence;
      activityClientSeq?: number;
    };

export type AgentLifecycleRecordSnapshot<SpawnFailBackoff = unknown, FingerprintFence = unknown> = {
  runningAgentIds: readonly string[];
  queuedAgentIds: readonly string[];
  startingAgentIds: readonly string[];
  idleRestartSnapshots: readonly (readonly [agentId: string, restartSnapshot: AgentRestartSnapshot])[];
  terminalFailures: readonly (readonly [agentId: string, failure: AgentTerminalFailure])[];
  activeSpawnFailBackoffs: readonly (readonly [agentId: string, backoff: SpawnFailBackoff])[];
  pendingStartRebinds: readonly (readonly [agentId: string, pendingStartRebind: PendingStartRebind])[];
  pendingSpawnCauses: readonly (readonly [agentId: string, cause: string])[];
  runtimeErrorFingerprintFences: readonly (readonly [agentId: string, fence: FingerprintFence])[];
  activityClientSeqs: readonly (readonly [agentId: string, seq: number])[];
};

export class AgentLifecycleRecords<SpawnFailBackoff = unknown, FingerprintFence = unknown> {
  readonly idleRestartSnapshots = new Map<string, AgentRestartSnapshot>();
  readonly terminalFailures = new Map<string, AgentTerminalFailure>();
  readonly activeSpawnFailBackoffs = new Map<string, SpawnFailBackoff>();
  readonly pendingStartRebinds = new Map<string, PendingStartRebind>();
  readonly pendingSpawnCauses = new Map<string, string>();
  readonly runtimeErrorFingerprintFences = new Map<string, FingerprintFence>();
  readonly activityClientSeqs = new Map<string, number>();
  private readonly stopEpochs = new Map<string, number>();
  private readonly startEpochs = new Map<string, number>();
  private readonly statusTransitions = new AgentStatusTransitionTrace();

  recordStop(agentId: string): number {
    const next = (this.stopEpochs.get(agentId) ?? 0) + 1;
    this.stopEpochs.set(agentId, next);
    return next;
  }

  stopEpoch(agentId: string): number {
    return this.stopEpochs.get(agentId) ?? 0;
  }

  stopEpochChanged(agentId: string, epoch: number): boolean {
    return this.stopEpoch(agentId) !== epoch;
  }

  recordStart(agentId: string): number {
    const next = (this.startEpochs.get(agentId) ?? 0) + 1;
    this.startEpochs.set(agentId, next);
    return next;
  }

  startEpoch(agentId: string): number {
    return this.startEpochs.get(agentId) ?? 0;
  }

  startEpochChanged(agentId: string, epoch: number): boolean {
    return this.startEpoch(agentId) !== epoch;
  }

  nextActivityClientSeq(agentId: string): number {
    const next = (this.activityClientSeqs.get(agentId) ?? 0) + 1;
    this.activityClientSeqs.set(agentId, next);
    return next;
  }

  deleteActivityClientSeq(agentId: string): boolean {
    return this.activityClientSeqs.delete(agentId);
  }

  agentStatusTransitionAttrs(input: AgentStatusTransitionInput): Record<string, unknown> {
    return this.statusTransitions.record(input);
  }

  getRestartSnapshot(agentId: string): AgentRestartSnapshot | undefined {
    return this.idleRestartSnapshots.get(agentId);
  }

  setRestartSnapshot(agentId: string, snapshot: AgentRestartSnapshot): void {
    this.idleRestartSnapshots.set(agentId, snapshot);
  }

  deleteRestartSnapshot(agentId: string): boolean {
    return this.idleRestartSnapshots.delete(agentId);
  }

  clearRestartSnapshots(): void {
    this.idleRestartSnapshots.clear();
  }

  restartSnapshotEntries(): IterableIterator<[string, AgentRestartSnapshot]> {
    return this.idleRestartSnapshots.entries();
  }

  restartSnapshotAgentIds(): IterableIterator<string> {
    return this.idleRestartSnapshots.keys();
  }

  getTerminalFailure(agentId: string): AgentTerminalFailure | undefined {
    return this.terminalFailures.get(agentId);
  }

  setTerminalFailure(agentId: string, failure: AgentTerminalFailure): void {
    this.terminalFailures.set(agentId, failure);
  }

  deleteTerminalFailure(agentId: string): boolean {
    return this.terminalFailures.delete(agentId);
  }

  terminalFailureAgentIds(): IterableIterator<string> {
    return this.terminalFailures.keys();
  }

  getSpawnFailBackoff(agentId: string): SpawnFailBackoff | undefined {
    return this.activeSpawnFailBackoffs.get(agentId);
  }

  getOrCreateSpawnFailBackoff(agentId: string, create: () => SpawnFailBackoff): SpawnFailBackoff {
    let state = this.activeSpawnFailBackoffs.get(agentId);
    if (!state) {
      state = create();
      this.activeSpawnFailBackoffs.set(agentId, state);
    }
    return state;
  }

  deleteSpawnFailBackoff(agentId: string): boolean {
    return this.activeSpawnFailBackoffs.delete(agentId);
  }

  activeSpawnFailBackoffAgentIds(now: number, isActive: (backoff: SpawnFailBackoff, now: number) => boolean): string[] {
    return [...this.activeSpawnFailBackoffs.entries()]
      .filter(([, state]) => isActive(state, now))
      .map(([agentId]) => agentId);
  }

  getPendingStartRebind(agentId: string): PendingStartRebind | undefined {
    return this.pendingStartRebinds.get(agentId);
  }

  setPendingStartRebind(agentId: string, start: PendingStartRebind): void {
    this.pendingStartRebinds.set(agentId, start);
  }

  deletePendingStartRebind(agentId: string): boolean {
    return this.pendingStartRebinds.delete(agentId);
  }

  getPendingSpawnCause(agentId: string): string | undefined {
    return this.pendingSpawnCauses.get(agentId);
  }

  setPendingSpawnCause(agentId: string, cause: string): void {
    this.pendingSpawnCauses.set(agentId, cause);
  }

  deletePendingSpawnCause(agentId: string): boolean {
    return this.pendingSpawnCauses.delete(agentId);
  }

  getRuntimeErrorFingerprintFence(agentId: string): FingerprintFence | undefined {
    return this.runtimeErrorFingerprintFences.get(agentId);
  }

  setRuntimeErrorFingerprintFence(agentId: string, fence: FingerprintFence): void {
    this.runtimeErrorFingerprintFences.set(agentId, fence);
  }

  deleteRuntimeErrorFingerprintFence(agentId: string): boolean {
    return this.runtimeErrorFingerprintFences.delete(agentId);
  }

  runtimeErrorFingerprintFenceAgentIds(): IterableIterator<string> {
    return this.runtimeErrorFingerprintFences.keys();
  }

  snapshot(args: {
    runningAgentIds: readonly string[];
    queuedAgentIds: readonly string[];
    startingAgentIds: readonly string[];
    now: number;
    isSpawnFailBackoffActive: (backoff: SpawnFailBackoff, now: number) => boolean;
  }): AgentLifecycleRecordSnapshot<SpawnFailBackoff, FingerprintFence> {
    return {
      runningAgentIds: args.runningAgentIds,
      queuedAgentIds: args.queuedAgentIds,
      startingAgentIds: args.startingAgentIds,
      idleRestartSnapshots: [...this.idleRestartSnapshots.entries()],
      terminalFailures: [...this.terminalFailures.entries()],
      activeSpawnFailBackoffs: [...this.activeSpawnFailBackoffs.entries()]
        .filter(([, state]) => args.isSpawnFailBackoffActive(state, args.now)),
      pendingStartRebinds: [...this.pendingStartRebinds.entries()],
      pendingSpawnCauses: [...this.pendingSpawnCauses.entries()],
      runtimeErrorFingerprintFences: [...this.runtimeErrorFingerprintFences.entries()],
      activityClientSeqs: [...this.activityClientSeqs.entries()],
    };
  }

  assertInvariants(context: string, snapshot: AgentLifecycleRecordSnapshot<SpawnFailBackoff, FingerprintFence>): void {
    assertAgentLifecycleRecordInvariants(context, snapshot);
  }
}

type AgentLifecycleAuxiliaryFacts<SpawnFailBackoff = unknown, FingerprintFence = unknown> = {
  restartSnapshot?: AgentRestartSnapshot;
  terminalFailure?: AgentTerminalFailure;
  activeSpawnFailBackoff?: SpawnFailBackoff;
  pendingStartRebind?: PendingStartRebind;
  pendingSpawnCause?: string;
  runtimeErrorFingerprintFence?: FingerprintFence;
  activityClientSeq?: number;
};

export function buildAgentLifecycleRecords<SpawnFailBackoff = unknown, FingerprintFence = unknown>(
  snapshot: AgentLifecycleRecordSnapshot<SpawnFailBackoff, FingerprintFence>,
): Map<string, AgentLifecycleRecord<SpawnFailBackoff, FingerprintFence>> {
  const running = new Set(snapshot.runningAgentIds);
  const queued = new Set(snapshot.queuedAgentIds);
  const starting = new Set(snapshot.startingAgentIds);
  const facts = new Map<string, AgentLifecycleAuxiliaryFacts<SpawnFailBackoff, FingerprintFence>>();

  for (const agentId of snapshot.runningAgentIds) {
    factsFor(facts, agentId);
  }
  for (const agentId of snapshot.queuedAgentIds) {
    factsFor(facts, agentId);
  }
  for (const agentId of snapshot.startingAgentIds) {
    factsFor(facts, agentId);
  }

  for (const [agentId, restartSnapshot] of snapshot.idleRestartSnapshots) {
    factsFor(facts, agentId).restartSnapshot = restartSnapshot;
  }
  for (const [agentId, failure] of snapshot.terminalFailures) {
    factsFor(facts, agentId).terminalFailure = failure;
  }
  for (const [agentId, backoff] of snapshot.activeSpawnFailBackoffs) {
    factsFor(facts, agentId).activeSpawnFailBackoff = backoff;
  }
  for (const [agentId, pendingStartRebind] of snapshot.pendingStartRebinds) {
    factsFor(facts, agentId).pendingStartRebind = pendingStartRebind;
  }
  for (const [agentId, cause] of snapshot.pendingSpawnCauses) {
    factsFor(facts, agentId).pendingSpawnCause = cause;
  }
  for (const [agentId, fence] of snapshot.runtimeErrorFingerprintFences) {
    factsFor(facts, agentId).runtimeErrorFingerprintFence = fence;
  }
  for (const [agentId, seq] of snapshot.activityClientSeqs) {
    factsFor(facts, agentId).activityClientSeq = seq;
  }

  const records = new Map<string, AgentLifecycleRecord<SpawnFailBackoff, FingerprintFence>>();
  for (const [agentId, agentFacts] of facts) {
    if (queued.has(agentId) && starting.has(agentId)) {
      throw new Error(`queued and starting facts overlap for ${agentId}`);
    }

    if (agentFacts.terminalFailure) {
      assertTerminalRecordFacts(agentId, agentFacts, running.has(agentId));
      records.set(agentId, {
        kind: "terminal",
        agentId,
        terminalFailure: agentFacts.terminalFailure,
        fingerprintFence: agentFacts.runtimeErrorFingerprintFence,
        activityClientSeq: agentFacts.activityClientSeq,
      });
      continue;
    }

    if (agentFacts.activeSpawnFailBackoff !== undefined) {
      if (running.has(agentId)) {
        throw new Error(`running process and active cooldown both present for ${agentId}`);
      }
      if (!agentFacts.restartSnapshot) {
        throw new Error(`active cooldown without restart config for ${agentId}`);
      }
      records.set(agentId, {
        kind: "cooldown",
        agentId,
        restartSnapshot: agentFacts.restartSnapshot,
        spawnFailBackoff: agentFacts.activeSpawnFailBackoff,
        fingerprintFence: agentFacts.runtimeErrorFingerprintFence,
        activityClientSeq: agentFacts.activityClientSeq,
      });
      continue;
    }

    if (running.has(agentId)) {
      records.set(agentId, {
        kind: "running",
        agentId,
        restartSnapshot: agentFacts.restartSnapshot,
        pendingStartRebind: agentFacts.pendingStartRebind,
        pendingSpawnCause: agentFacts.pendingSpawnCause,
        fingerprintFence: agentFacts.runtimeErrorFingerprintFence,
        activityClientSeq: agentFacts.activityClientSeq,
      });
      continue;
    }

    if (starting.has(agentId)) {
      records.set(agentId, {
        kind: "starting",
        agentId,
        restartSnapshot: agentFacts.restartSnapshot,
        pendingStartRebind: agentFacts.pendingStartRebind,
        activityClientSeq: agentFacts.activityClientSeq,
      });
      continue;
    }

    if (queued.has(agentId)) {
      records.set(agentId, {
        kind: "queued",
        agentId,
        restartSnapshot: agentFacts.restartSnapshot,
        pendingStartRebind: agentFacts.pendingStartRebind,
        activityClientSeq: agentFacts.activityClientSeq,
      });
      continue;
    }

    if (agentFacts.restartSnapshot) {
      records.set(agentId, {
        kind: "idle",
        agentId,
        restartSnapshot: agentFacts.restartSnapshot,
        fingerprintFence: agentFacts.runtimeErrorFingerprintFence,
        activityClientSeq: agentFacts.activityClientSeq,
      });
    }
  }

  return records;
}

export function assertAgentLifecycleRecordInvariants<SpawnFailBackoff = unknown, FingerprintFence = unknown>(
  context: string,
  snapshot: AgentLifecycleRecordSnapshot<SpawnFailBackoff, FingerprintFence>,
): void {
  try {
    buildAgentLifecycleRecords(snapshot);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Agent lifecycle record invariant violation after ${context}: ${detail}`);
  }
}

function factsFor<SpawnFailBackoff = unknown, FingerprintFence = unknown>(
  facts: Map<string, AgentLifecycleAuxiliaryFacts<SpawnFailBackoff, FingerprintFence>>,
  agentId: string,
): AgentLifecycleAuxiliaryFacts<SpawnFailBackoff, FingerprintFence> {
  let value = facts.get(agentId);
  if (!value) {
    value = {};
    facts.set(agentId, value);
  }
  return value;
}

function assertTerminalRecordFacts(
  agentId: string,
  facts: AgentLifecycleAuxiliaryFacts,
  isRunning: boolean,
): void {
  if (isRunning) {
    throw new Error(`terminal failure while process is still registered for ${agentId}`);
  }
  if (facts.restartSnapshot) {
    throw new Error(`terminal failure and idle restart config both present for ${agentId}`);
  }
  if (facts.pendingStartRebind) {
    throw new Error(`terminal failure and pending start rebind both present for ${agentId}`);
  }
}
