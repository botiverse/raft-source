import type {
  MachineAcceptanceSnapshot,
  MachineDispatchIdentity,
  MachineEffectIntent,
  MachineOperationRecord,
  MachineProcessIdentity,
} from "./machineOperationStore.js";

/** Pure, side-effect-free machine convergence reducer. */

export type MachineConvergenceEvent =
  | { kind: "claim"; expectedPhaseVersion: number; claimEpoch: number; holder: string; leaseUntil: string }
  | { kind: "first_hop_observed"; expectedPhaseVersion: number; progressOrdinal: number }
  | { kind: "arm_leg"; expectedPhaseVersion: number; role: "coordinator" | "standby"; process: MachineProcessIdentity }
  | { kind: "leg_crashed"; expectedPhaseVersion: number; role: "origin_runner" | "coordinator" | "standby" | "target_supervisor"; process: MachineProcessIdentity }
  | { kind: "request_old_service_stop"; expectedPhaseVersion: number; source: MachineProcessIdentity }
  | { kind: "old_service_dead"; expectedPhaseVersion: number; source: MachineProcessIdentity }
  | { kind: "target_generation_allocated"; expectedPhaseVersion: number; generation: string }
  | { kind: "target_supervisor_live"; expectedPhaseVersion: number; generation: string; process: MachineProcessIdentity }
  | { kind: "managed_set_observed"; expectedPhaseVersion: number; revision: number; liveRunners: MachineProcessIdentity[] }
  | { kind: "write_terminal_outbox"; expectedPhaseVersion: number; at: string }
  | { kind: "observe_receipt"; expectedPhaseVersion: number; at: string }
  | { kind: "progress"; expectedPhaseVersion: number; progressOrdinal: number }
  | { kind: "reconcile"; expectedPhaseVersion: number; executor: "origin_runner" | "coordinator" | "standby" | "target_supervisor" }
  | { kind: "explicit_start"; expectedPhaseVersion: number; process: MachineProcessIdentity };

export type MachineReducerResult =
  | { kind: "applied"; record: MachineOperationRecord; effects: MachineEffectIntent[] }
  | { kind: "replay"; record: MachineOperationRecord; effects: [] }
  | { kind: "conflict"; code: "OPERATION_IDENTITY_CONFLICT"; record: MachineOperationRecord; effects: [] }
  | { kind: "rejected"; code: string; record: MachineOperationRecord; effects: [] };

function sameIdentity(left: MachineDispatchIdentity, right: MachineDispatchIdentity): boolean {
  return left.dispatchOperationId === right.dispatchOperationId
    && left.parentUserOperationId === right.parentUserOperationId
    && left.dispatchAction === right.dispatchAction
    && left.targetVersion === right.targetVersion
    && left.adapter === right.adapter
    && left.originServerId === right.originServerId
    && left.machineId === right.machineId;
}

function sameProcess(left: MachineProcessIdentity | null, right: MachineProcessIdentity): boolean {
  return left?.pid === right.pid
    && left.startIdentity === right.startIdentity
    && left.role === right.role
    && left.serverId === right.serverId
    && left.version === right.version;
}

const PHASE_ORDER: MachineOperationRecord["phase"][] = [
  "accepted",
  "mutation_claimed",
  "first_hop_observed",
  "handoff_arming",
  "handoff_armed",
  "old_service_stop_claimed",
  "old_service_dead",
  "target_supervisor_live",
  "managed_set_converged",
  "terminal_outbox",
  "receipt_observed",
  "finalized",
];

function atLeast(record: MachineOperationRecord, phase: MachineOperationRecord["phase"]): boolean {
  return PHASE_ORDER.indexOf(record.phase) >= PHASE_ORDER.indexOf(phase);
}

function rejected(record: MachineOperationRecord, code: string): MachineReducerResult {
  return { kind: "rejected", code, record, effects: [] };
}

function replay(record: MachineOperationRecord): MachineReducerResult {
  return { kind: "replay", record, effects: [] };
}

function appendProcess(
  values: MachineProcessIdentity[],
  process: MachineProcessIdentity,
): MachineProcessIdentity[] {
  return values.some((candidate) => sameProcess(candidate, process)) ? values : [...values, process];
}

export function createMachineOperationRecord(input: {
  identity: MachineDispatchIdentity;
  acceptance: MachineAcceptanceSnapshot;
  originRunner: MachineProcessIdentity;
}): MachineOperationRecord {
  return {
    schemaVersion: 1,
    identity: input.identity,
    acceptance: input.acceptance,
    phase: "accepted",
    phaseVersion: 0,
    claimEpoch: 0,
    leaseHolder: null,
    leaseUntil: null,
    firstHopProgressOrdinal: 0,
    currentManagedSetRevision: input.acceptance.acceptedManagedSetRevision,
    observedTargetGeneration: null,
    originRunner: input.originRunner,
    coordinator: null,
    standby: null,
    targetSupervisor: null,
    appendOnlyObservedOldProcessIdentities: [],
    effectIntents: [],
    terminalOutbox: null,
    receipt: null,
  };
}

export function acceptMachineOperation(
  existing: MachineOperationRecord | null,
  incoming: MachineOperationRecord,
): MachineReducerResult {
  if (!existing) return { kind: "applied", record: incoming, effects: [] };
  if (!sameIdentity(existing.identity, incoming.identity)) {
    return { kind: "conflict", code: "OPERATION_IDENTITY_CONFLICT", record: existing, effects: [] };
  }
  return { kind: "replay", record: existing, effects: [] };
}

function withEffect(
  record: MachineOperationRecord,
  effect: MachineEffectIntent,
): { record: MachineOperationRecord; effects: MachineEffectIntent[] } {
  return {
    record: { ...record, effectIntents: [...record.effectIntents, effect] },
    effects: [effect],
  };
}

function applied(record: MachineOperationRecord, effects: MachineEffectIntent[] = []): MachineReducerResult {
  return { kind: "applied", record: { ...record, phaseVersion: record.phaseVersion + 1 }, effects };
}

function withUniqueEffect(
  record: MachineOperationRecord,
  effect: MachineEffectIntent,
): { record: MachineOperationRecord; effects: MachineEffectIntent[] } {
  if (record.effectIntents.some((candidate) => candidate.key === effect.key)) {
    return { record, effects: [] };
  }
  return withEffect(record, effect);
}

export function reduceMachineConvergence(
  current: MachineOperationRecord,
  event: MachineConvergenceEvent,
): MachineReducerResult {
  if (event.expectedPhaseVersion !== current.phaseVersion) {
    return rejected(current, "STALE_PHASE_VERSION");
  }
  if (current.phase === "finalized" && event.kind !== "reconcile") return replay(current);
  switch (event.kind) {
    case "claim": {
      if (event.claimEpoch < current.claimEpoch) return rejected(current, "STALE_CLAIM_EPOCH");
      if (event.claimEpoch === current.claimEpoch && current.leaseHolder === event.holder) return replay(current);
      if (event.claimEpoch === current.claimEpoch && current.leaseHolder !== event.holder) {
        return rejected(current, "CLAIM_EPOCH_CONFLICT");
      }
      return applied({
        ...current,
        phase: atLeast(current, "mutation_claimed") ? current.phase : "mutation_claimed",
        claimEpoch: event.claimEpoch,
        leaseHolder: event.holder,
        leaseUntil: event.leaseUntil,
      });
    }
    case "first_hop_observed":
      if (event.progressOrdinal <= current.firstHopProgressOrdinal) return replay(current);
      return applied({
        ...current,
        phase: atLeast(current, "first_hop_observed") ? current.phase : "first_hop_observed",
        firstHopProgressOrdinal: event.progressOrdinal,
      });
    case "arm_leg": {
      if (atLeast(current, "old_service_stop_claimed")) return rejected(current, "HANDOFF_ALREADY_COMMITTED");
      const existing = event.role === "coordinator" ? current.coordinator : current.standby;
      if (existing && !sameProcess(existing, event.process)) return rejected(current, "HANDOFF_LEG_IDENTITY_CONFLICT");
      if (existing) return replay(current);
      const record = {
        ...current,
        phase: (event.role === "standby" && current.coordinator)
          || (event.role === "coordinator" && current.standby)
          ? "handoff_armed" as const
          : "handoff_arming" as const,
        ...(event.role === "coordinator" ? { coordinator: event.process } : { standby: event.process }),
      };
      return applied(record);
    }
    case "leg_crashed": {
      if (current.receipt) return replay(current);
      const expected = event.role === "origin_runner"
        ? current.originRunner
        : event.role === "coordinator"
          ? current.coordinator
          : event.role === "standby"
            ? current.standby
            : current.targetSupervisor;
      if (!sameProcess(expected, event.process)) return replay(current);
      const targetSupervisorCrashed = event.role === "target_supervisor";
      const next = {
        ...current,
        ...(event.role === "origin_runner" ? { originRunner: null } : {}),
        ...(event.role === "coordinator" ? { coordinator: null } : {}),
        ...(event.role === "standby" ? { standby: null } : {}),
        ...(targetSupervisorCrashed ? {
          // A live target generation is evidence, not immutable dispatch
          // identity. Before the Server observes a receipt, a crashed target
          // invalidates managed-set/terminal evidence and a surviving handoff
          // leg must allocate and attest a replacement generation.
          phase: "old_service_dead" as const,
          observedTargetGeneration: null,
          targetSupervisor: null,
          currentManagedSetRevision: current.acceptance.acceptedManagedSetRevision,
          terminalOutbox: null,
          receipt: null,
        } : {}),
        appendOnlyObservedOldProcessIdentities: appendProcess(
          current.appendOnlyObservedOldProcessIdentities,
          event.process,
        ),
      };
      const effect: MachineEffectIntent | null = event.role === "coordinator"
        ? { key: `coordinator:${current.identity.dispatchOperationId}:${current.claimEpoch + 1}`, kind: "spawn_coordinator" }
        : event.role === "standby"
          ? { key: `standby:${current.identity.dispatchOperationId}:${current.claimEpoch + 1}`, kind: "spawn_standby" }
        : targetSupervisorCrashed
            ? { key: `promote:${current.identity.dispatchOperationId}:${current.claimEpoch + 1}`, kind: "promote_standby" }
            : null;
      if (!effect) return applied(next);
      const intent = withUniqueEffect(next, effect);
      return applied(intent.record, intent.effects);
    }
    case "request_old_service_stop": {
      if (!current.coordinator || !current.standby || current.phase !== "handoff_armed") {
        return rejected(current, "HANDOFF_NOT_ARMED");
      }
      const source = current.acceptance.capturedOldProcessIdentities.find((process) => process.role === "service");
      if (!source || !sameProcess(source, event.source)) return rejected(current, "SOURCE_SERVICE_IDENTITY_MISMATCH");
      const effect: MachineEffectIntent = {
        key: `stop:${current.identity.dispatchOperationId}:${event.source.pid}:${event.source.startIdentity}`,
        kind: "stop_old_service",
        process: event.source,
      };
      const next = withUniqueEffect({ ...current, phase: "old_service_stop_claimed" }, effect);
      return applied(next.record, next.effects);
    }
    case "old_service_dead": {
      if (current.phase !== "old_service_stop_claimed") return rejected(current, "OLD_SERVICE_STOP_NOT_CLAIMED");
      const source = current.acceptance.capturedOldProcessIdentities.find((process) => process.role === "service");
      if (!source || !sameProcess(source, event.source)) return rejected(current, "SOURCE_SERVICE_IDENTITY_MISMATCH");
      return applied({
        ...current,
        phase: "old_service_dead",
        appendOnlyObservedOldProcessIdentities: appendProcess(
          current.appendOnlyObservedOldProcessIdentities,
          event.source,
        ),
      });
    }
    case "target_generation_allocated":
      if (current.observedTargetGeneration === event.generation) return replay(current);
      if (current.observedTargetGeneration) return rejected(current, "TARGET_GENERATION_CONFLICT");
      return applied({ ...current, observedTargetGeneration: event.generation });
    case "target_supervisor_live":
      if (!atLeast(current, "old_service_dead")) return rejected(current, "OLD_SERVICE_STILL_LIVE");
      if (current.observedTargetGeneration !== event.generation) return rejected(current, "TARGET_GENERATION_MISMATCH");
      if (event.process.role !== "service" || event.process.version !== current.identity.targetVersion) {
        return rejected(current, "TARGET_SUPERVISOR_ATTESTATION_INVALID");
      }
      return applied({
        ...current,
        phase: "target_supervisor_live",
        observedTargetGeneration: event.generation,
        targetSupervisor: event.process,
      });
    case "managed_set_observed": {
      if (current.phase !== "target_supervisor_live") return rejected(current, "TARGET_SUPERVISOR_NOT_LIVE");
      const liveServerIds = new Set(event.liveRunners.map((runner) => runner.serverId));
      if (event.revision < current.acceptance.acceptedManagedSetRevision
        || current.acceptance.acceptedManagedServerIds.some((serverId) => !liveServerIds.has(serverId))
        || event.liveRunners.some((runner) => runner.role !== "managed_runner"
          || runner.version !== current.identity.targetVersion)) {
        return rejected(current, "MANAGED_SET_NOT_CONVERGED");
      }
      return applied({
        ...current,
        phase: "managed_set_converged",
        currentManagedSetRevision: event.revision,
      });
    }
    case "write_terminal_outbox": {
      if (current.phase !== "managed_set_converged") return rejected(current, "MACHINE_CONVERGENCE_INCOMPLETE");
      if (current.terminalOutbox) return replay(current);
      const effect: MachineEffectIntent = {
        key: `outbox:${current.identity.dispatchOperationId}`,
        kind: "write_terminal_outbox",
      };
      const next = withUniqueEffect({
        ...current,
        phase: "terminal_outbox",
        terminalOutbox: { dispatchOperationId: current.identity.dispatchOperationId, writtenAt: event.at },
      }, effect);
      return applied(next.record, next.effects);
    }
    case "observe_receipt":
      if (!current.terminalOutbox) return rejected(current, "TERMINAL_OUTBOX_MISSING");
      if (current.receipt) return replay(current);
      return applied({
        ...current,
        phase: "receipt_observed",
        receipt: { dispatchOperationId: current.identity.dispatchOperationId, observedAt: event.at },
      });
    case "progress":
      if (event.progressOrdinal <= current.firstHopProgressOrdinal) return replay(current);
      return applied({
        ...current,
        phase: atLeast(current, "first_hop_observed") ? current.phase : "first_hop_observed",
        firstHopProgressOrdinal: event.progressOrdinal,
      });
    case "explicit_start":
      if (current.originRunner && sameProcess(current.originRunner, event.process)) return replay(current);
      return applied({ ...current, originRunner: event.process, leaseHolder: null, leaseUntil: null });
    case "reconcile": {
      if (current.phase === "receipt_observed") {
        return applied({ ...current, phase: "finalized", leaseHolder: null, leaseUntil: null });
      }
      const effect: MachineEffectIntent | null = !current.coordinator && !atLeast(current, "target_supervisor_live")
        ? { key: `coordinator:${current.identity.dispatchOperationId}:${current.claimEpoch + 1}`, kind: "spawn_coordinator" }
        : current.coordinator && !current.standby && !atLeast(current, "old_service_stop_claimed")
          ? { key: `standby:${current.identity.dispatchOperationId}:${current.claimEpoch + 1}`, kind: "spawn_standby" }
          : current.phase === "old_service_dead" && current.observedTargetGeneration
            ? { key: `promote:${current.identity.dispatchOperationId}:${current.observedTargetGeneration}`, kind: "promote_standby", targetGeneration: current.observedTargetGeneration }
            : current.phase === "managed_set_converged" && !current.terminalOutbox
              ? { key: `outbox:${current.identity.dispatchOperationId}`, kind: "write_terminal_outbox" }
              : null;
      if (!effect) return replay(current);
      const intent = withUniqueEffect(current, effect);
      return applied(intent.record, intent.effects);
    }
  }
}
