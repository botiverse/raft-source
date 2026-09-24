import { randomUUID } from "node:crypto";

export type AgentNoProcessResidencySnapshot = {
  runningAgentIds: readonly string[];
  queuedAgentIds: readonly string[];
  startingAgentIds: readonly string[];
  idleAgentIds: readonly string[];
  terminalFailureAgentIds: readonly string[];
  activeCooldownAgentIds: readonly string[];
  fingerprintFenceAgentIds: readonly string[];
  pendingDeliveryAgentIds: readonly string[];
};

export type AgentNoProcessResidencyAllowedSnapshot = {
  queuedAgentIds: string[];
  startingAgentIds: string[];
  terminalRecoveryAgentIds: string[];
  cooldownAgentIds: string[];
};

export type AgentNoProcessResidencyState =
  | "queued_start"
  | "starting_process"
  | "spawn_fail_cooldown"
  | "terminal_runtime_error";

export type AgentNoProcessResidencyCloseResult =
  | "advanced"
  | "terminal"
  | "suppressed"
  | "evicted"
  | "lineage_failed"
  | "timeout";

export type AgentNoProcessResidencyTransitionIdentity = {
  agentId: string;
  agentLaunchId: string;
  agentLaunchIdPresent: boolean;
  serverId: string;
  machineId: string;
  runtime: string;
  driver: string;
  launchSource: string;
};

export type AgentNoProcessResidencyEnterInput = AgentNoProcessResidencyTransitionIdentity & {
  state: AgentNoProcessResidencyState;
  isWaitState: boolean;
  fenceKind?: string;
  deadlineUnixMs?: number | null;
  failureKind?: string;
  negativeEvidenceBucket?: string;
};

export type AgentNoProcessResidencyCloseInput = {
  closeResult: AgentNoProcessResidencyCloseResult;
  failureKind?: string;
  negativeEvidenceBucket?: string;
};

export type AgentNoProcessResidencyTransitionRow = {
  span_name: "launch_residency_transition";
  phase: "process_residency";
  agent_launch_id: string;
  agent_id: string;
  server_id: string;
  machine_id: string;
  runtime: string;
  driver: string;
  launch_source: string;
  state_instance_id: string;
  residency_state_instance_id: string;
  transition_seq: number;
  residency_transition_seq: number;
  transition_kind: "enter" | "close";
  state: AgentNoProcessResidencyState;
  residency: AgentNoProcessResidencyState;
  agent_launch_id_present: boolean;
  is_wait_state?: boolean;
  fence_kind?: string;
  deadline_unix_ms?: number;
  phase_result?: "entered";
  close_result?: AgentNoProcessResidencyCloseResult;
  failure_kind?: string;
  negative_evidence_bucket?: string;
};

type OpenNoProcessResidencyTransition = AgentNoProcessResidencyTransitionIdentity & {
  state: AgentNoProcessResidencyState;
  stateInstanceId: string;
  isWaitState: boolean;
  fenceKind?: string;
  deadlineUnixMs?: number;
  failureKind?: string;
  negativeEvidenceBucket?: string;
};

export class AgentNoProcessResidencyTransitions {
  private readonly open = new Map<string, OpenNoProcessResidencyTransition>();
  private transitionSeq = 0;

  enter(input: AgentNoProcessResidencyEnterInput): AgentNoProcessResidencyTransitionRow[] {
    const existing = this.open.get(input.agentId);
    if (existing && existing.state === input.state && existing.agentLaunchId === input.agentLaunchId) {
      return [];
    }

    const rows: AgentNoProcessResidencyTransitionRow[] = [];
    if (existing) {
      rows.push(this.closeRow(existing, { closeResult: "advanced" }));
    }

    const current: OpenNoProcessResidencyTransition = {
      agentId: input.agentId,
      agentLaunchId: input.agentLaunchId,
      agentLaunchIdPresent: input.agentLaunchIdPresent,
      serverId: input.serverId,
      machineId: input.machineId,
      runtime: input.runtime,
      driver: input.driver,
      launchSource: input.launchSource,
      state: input.state,
      stateInstanceId: randomUUID(),
      isWaitState: input.isWaitState,
      fenceKind: input.fenceKind,
      deadlineUnixMs: typeof input.deadlineUnixMs === "number" ? input.deadlineUnixMs : undefined,
      failureKind: input.failureKind,
      negativeEvidenceBucket: input.negativeEvidenceBucket,
    };
    this.open.set(input.agentId, current);
    rows.push(this.enterRow(current));
    return rows;
  }

  close(agentId: string, input: AgentNoProcessResidencyCloseInput): AgentNoProcessResidencyTransitionRow[] {
    const existing = this.open.get(agentId);
    if (!existing) return [];
    this.open.delete(agentId);
    return [this.closeRow(existing, input)];
  }

  private enterRow(open: OpenNoProcessResidencyTransition): AgentNoProcessResidencyTransitionRow {
    return this.baseRow(open, {
      transition_kind: "enter",
      phase_result: "entered",
      is_wait_state: open.isWaitState,
      fence_kind: open.fenceKind,
      deadline_unix_ms: open.deadlineUnixMs,
      failure_kind: open.failureKind,
      negative_evidence_bucket: open.negativeEvidenceBucket,
    });
  }

  private closeRow(open: OpenNoProcessResidencyTransition, input: AgentNoProcessResidencyCloseInput): AgentNoProcessResidencyTransitionRow {
    return this.baseRow(open, {
      transition_kind: "close",
      close_result: input.closeResult,
      is_wait_state: open.isWaitState,
      fence_kind: open.fenceKind,
      deadline_unix_ms: open.deadlineUnixMs,
      failure_kind: input.failureKind ?? open.failureKind,
      negative_evidence_bucket: input.negativeEvidenceBucket ?? open.negativeEvidenceBucket,
    });
  }

  private baseRow(
    open: OpenNoProcessResidencyTransition,
    attrs: Pick<AgentNoProcessResidencyTransitionRow, "transition_kind"> & Partial<AgentNoProcessResidencyTransitionRow>,
  ): AgentNoProcessResidencyTransitionRow {
    const transitionSeq = ++this.transitionSeq;
    const row: AgentNoProcessResidencyTransitionRow = {
      span_name: "launch_residency_transition",
      phase: "process_residency",
      agent_launch_id: open.agentLaunchId,
      agent_id: open.agentId,
      server_id: open.serverId,
      machine_id: open.machineId,
      runtime: open.runtime,
      driver: open.driver,
      launch_source: open.launchSource,
      state_instance_id: open.stateInstanceId,
      residency_state_instance_id: open.stateInstanceId,
      transition_seq: transitionSeq,
      residency_transition_seq: transitionSeq,
      transition_kind: attrs.transition_kind,
      state: open.state,
      residency: open.state,
      agent_launch_id_present: open.agentLaunchIdPresent,
    };

    return withoutUndefined({
      ...row,
      phase_result: attrs.phase_result,
      close_result: attrs.close_result,
      is_wait_state: attrs.is_wait_state,
      fence_kind: attrs.fence_kind,
      deadline_unix_ms: attrs.deadline_unix_ms,
      failure_kind: attrs.failure_kind,
      negative_evidence_bucket: attrs.negative_evidence_bucket,
    }) as AgentNoProcessResidencyTransitionRow;
  }
}

function withoutUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/**
 * Owns the manager-level facts that describe an agent with no live
 * AgentProcess. These facts are business state, not loose cache maps: they
 * decide whether a new wake may restart, buffer for a queued/starting spawn,
 * wait out spawn cooldown, wait for explicit terminal recovery, or reject as
 * hard inactive.
 *
 * Invariant I1 (cooldown is wakeable): an active spawn-fail cooldown is a
 * legal pending-delivery residency only when a restart-safe idle config also
 * exists. Cooldown without idle config is hard inactive evidence, not a place
 * to buffer user messages.
 *
 * Invariant I2 (terminal excludes auto-restart): terminal runtime failure and
 * idle restart config are mutually exclusive as stable no-process states.
 *
 * Invariant I3 (terminal excludes running): terminal failure is no-process
 * evidence. Any running+terminal overlap must stay inside one transition and
 * never be visible to the owner.
 *
 * Invariant I4 (pending has residency): start-pending delivery may exist only
 * for queued, starting, terminal-recovery, or active-cooldown-with-idle agents.
 *
 * Invariant I5 (fingerprint fence is evidence, not residency): a fence must be
 * tied to a live process, wakeable-idle retry evidence, or terminal-failure
 * evidence. A fence alone cannot route delivery by itself.
 */
export class AgentNoProcessResidency {
  static assertInvariants(context: string, snapshot: AgentNoProcessResidencySnapshot): void {
    const running = new Set(snapshot.runningAgentIds);
    const idle = new Set(snapshot.idleAgentIds);
    const terminal = new Set(snapshot.terminalFailureAgentIds);
    const activeCooldown = new Set(snapshot.activeCooldownAgentIds);
    const queued = new Set(snapshot.queuedAgentIds);
    const starting = new Set(snapshot.startingAgentIds);

    for (const agentId of activeCooldown) {
      if (!idle.has(agentId)) {
        throw new Error(`Agent no-process residency invariant violation after ${context}: active cooldown without restart config for ${agentId}`);
      }
    }

    for (const agentId of terminal) {
      if (idle.has(agentId)) {
        throw new Error(`Agent no-process residency invariant violation after ${context}: terminal failure and idle restart config both present for ${agentId}`);
      }
      if (running.has(agentId)) {
        throw new Error(`Agent no-process residency invariant violation after ${context}: terminal failure while process is still registered for ${agentId}`);
      }
    }

    const allowedPending = this.allowedStartPendingSnapshot(snapshot);
    const allowed = new Set<string>([
      ...allowedPending.queuedAgentIds,
      ...allowedPending.startingAgentIds,
      ...allowedPending.terminalRecoveryAgentIds,
      ...allowedPending.cooldownAgentIds,
    ]);
    for (const agentId of snapshot.pendingDeliveryAgentIds) {
      if (!allowed.has(agentId)) {
        throw new Error(`Agent no-process residency invariant violation after ${context}: pending delivery without queued/starting/terminal/cooldown residency for ${agentId}`);
      }
    }

    for (const agentId of snapshot.fingerprintFenceAgentIds) {
      if (!running.has(agentId) && !idle.has(agentId) && !terminal.has(agentId)) {
        throw new Error(`Agent no-process residency invariant violation after ${context}: fingerprint fence without running process, idle retry config, or terminal failure for ${agentId}`);
      }
    }

    // The queued/starting invariant belongs to AgentStartCoordinator, but this
    // owner depends on the two sets being disjoint for I4 to be meaningful.
    for (const agentId of queued) {
      if (starting.has(agentId)) {
        throw new Error(`Agent no-process residency invariant violation after ${context}: queued and starting facts overlap for ${agentId}`);
      }
    }
  }

  static allowedStartPendingSnapshot(snapshot: AgentNoProcessResidencySnapshot): AgentNoProcessResidencyAllowedSnapshot {
    const idle = new Set(snapshot.idleAgentIds);
    const cooldownAgentIds = snapshot.activeCooldownAgentIds.filter((agentId) => idle.has(agentId));
    return {
      queuedAgentIds: [...snapshot.queuedAgentIds],
      startingAgentIds: [...snapshot.startingAgentIds],
      terminalRecoveryAgentIds: [...snapshot.terminalFailureAgentIds],
      cooldownAgentIds,
    };
  }
}
